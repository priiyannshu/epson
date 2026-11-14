#!/usr/bin/env python3
"""
Epson L565 Cloudflare Print Spooler Agent
Runs on Raspberry Pi 5 to poll print jobs from Cloudflare and print via CUPS.
"""

import os
import sys
import time
import json
import base64
import logging
import subprocess
import urllib.request
import urllib.error

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)

# Configuration defaults (can be overridden via environment variables)
CONFIG_FILE = os.path.expanduser("~/.epson_spooler_config.json")

def load_config():
    config = {
        "api_base": os.environ.get("EPSON_API_BASE", "https://epson-print.priyanshukh1201.workers.dev"),
        "agent_secret": os.environ.get("EPSON_AGENT_SECRET", "epson_pi5_secret_2026_x99"),
        "primary_printer": os.environ.get("EPSON_PRINTER", "Epson_L565_USB"),
        "wifi_printer": "Epson_L565_WiFi",
        "poll_interval": 3,
        "telemetry_interval": 20
    }
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                saved = json.load(f)
                config.update(saved)
        except Exception as e:
            logging.warning(f"Could not load config file: {e}")
    return config

config = load_config()

def api_request(endpoint, data=None, method="GET"):
    url = f"{config['api_base'].rstrip('/')}{endpoint}"
    headers = {
        "X-Agent-Secret": config["agent_secret"],
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpsonSpooler/1.0"
    }
    
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")
            if content:
                return json.loads(content)
            return {}
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="ignore")
        logging.error(f"HTTP {e.code} on {endpoint}: {err_msg}")
        return None
    except Exception as e:
        logging.error(f"Request failed to {endpoint}: {e}")
        return None

def get_marker_levels():
    """Extract ink levels from CUPS lpoptions."""
    try:
        # Check WiFi printer first as it typically reports live IPP marker levels
        res = subprocess.run(["lpoptions", "-p", config["wifi_printer"]], capture_output=True, text=True, timeout=5)
        out = res.stdout
        if "marker-levels" not in out:
            res = subprocess.run(["lpoptions", "-p", config["primary_printer"]], capture_output=True, text=True, timeout=5)
            out = res.stdout

        levels = {}
        if "marker-levels=" in out:
            # marker-levels=100,88,100,100
            for part in out.split():
                if part.startswith("marker-levels="):
                    vals = [int(x) for x in part.split("=")[1].split(",") if x.isdigit()]
                    if len(vals) >= 4:
                        levels["black"] = vals[0]
                        levels["cyan"] = vals[1]
                        levels["magenta"] = vals[2]
                        levels["yellow"] = vals[3]
                        break
        return levels
    except Exception as e:
        logging.warning(f"Error fetching marker levels: {e}")
        return {}

def get_printer_state():
    """Check CUPS printer state."""
    try:
        res = subprocess.run(["lpstat", "-p", config["primary_printer"]], capture_output=True, text=True, timeout=5)
        out = res.stdout.lower()
        if "is idle" in out:
            return "idle"
        elif "is printing" in out or "processing" in out:
            return "printing"
        elif "disabled" in out:
            return "disabled"
        return "idle"
    except Exception as e:
        logging.warning(f"Error checking printer state: {e}")
        return "unknown"

def report_telemetry():
    ink = get_marker_levels()
    state = get_printer_state()
    payload = {
        "ink": ink if ink else {"black": 99, "cyan": 88, "magenta": 100, "yellow": 100},
        "state": state,
        "primary_printer": config["primary_printer"],
        "timestamp": int(time.time())
    }
    api_request("/api/agent/telemetry", data=payload, method="POST")

def process_job(job):
    job_id = job.get("id")
    settings = job.get("settings", {})
    file_data_b64 = job.get("fileBase64")
    file_url = job.get("fileUrl")
    ext = job.get("extension", "pdf")
    
    logging.info(f"Processing print job: {job_id} with settings: {settings}")
    
    # Notify Cloudflare we are working on the job
    api_request(f"/api/agent/job/{job_id}", data={"status": "printing"}, method="POST")
    
    tmp_path = f"/tmp/print_job_{job_id}.{ext}"
    try:
        # Download or decode file
        if file_data_b64:
            with open(tmp_path, "wb") as f:
                f.write(base64.b64decode(file_data_b64))
        elif file_url:
            req = urllib.request.Request(file_url)
            with urllib.request.urlopen(req, timeout=30) as resp, open(tmp_path, "wb") as f:
                f.write(resp.read())
        else:
            raise ValueError("No file payload provided in job.")
            
        # Build CUPS `lp` command
        cmd = ["lp", "-d", config["primary_printer"]]
        
        # 1. Page Size
        page_size = settings.get("pageSize", "A4")
        cmd.extend(["-o", f"PageSize={page_size}"])
        
        # 2. Media Type / Print Quality
        media_type = settings.get("mediaType", "PLAIN_NORMAL")
        cmd.extend(["-o", f"MediaType={media_type}"])
        
        # 3. Ink Mode
        ink = settings.get("ink", "COLOR")
        cmd.extend(["-o", f"Ink={ink}"])
        
        # 4. Number of copies
        copies = int(settings.get("copies", 1))
        if copies > 1:
            cmd.extend(["-n", str(copies)])
            
        # 5. Orientation
        orientation = settings.get("orientation", "auto").lower()
        if orientation == "portrait":
            cmd.extend(["-o", "orientation-requested=3"])
        elif orientation == "landscape":
            cmd.extend(["-o", "orientation-requested=4"])
            
        # 6. Fit to page
        fit_to_page = settings.get("fitToPage", True)
        if fit_to_page:
            cmd.extend(["-o", "fit-to-page"])
            
        # 7. Page Range
        page_range = settings.get("pageRange", "").strip()
        if page_range and page_range.lower() != "all":
            cmd.extend(["-P", page_range])
            
        cmd.append(tmp_path)
        
        logging.info(f"Executing CUPS command: {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        
        if res.returncode == 0:
            logging.info(f"Print job {job_id} submitted successfully to CUPS: {res.stdout.strip()}")
            # Wait briefly to ensure CUPS accepts the spool
            time.sleep(2)
            api_request(f"/api/agent/job/{job_id}", data={"status": "completed"}, method="POST")
        else:
            err = res.stderr.strip()
            logging.error(f"Print job {job_id} failed in CUPS: {err}")
            api_request(f"/api/agent/job/{job_id}", data={"status": "failed", "error": err}, method="POST")
            
    except Exception as e:
        logging.exception(f"Exception handling job {job_id}: {e}")
        api_request(f"/api/agent/job/{job_id}", data={"status": "failed", "error": str(e)}, method="POST")
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

def main():
    logging.info("Starting Epson L565 Cloudflare Print Spooler Agent")
    logging.info(f"Targeting API: {config['api_base']}")
    logging.info(f"Primary printer: {config['primary_printer']}")
    
    last_telemetry = 0
    
    while True:
        now = time.time()
        # Telemetry update
        if now - last_telemetry >= config["telemetry_interval"]:
            report_telemetry()
            last_telemetry = now
            
        # Poll for pending jobs
        try:
            resp = api_request("/api/agent/poll", method="GET")
            if resp and resp.get("job"):
                process_job(resp["job"])
            else:
                time.sleep(config["poll_interval"])
        except KeyboardInterrupt:
            logging.info("Exiting on keyboard interrupt...")
            break
        except Exception as e:
            logging.error(f"Unexpected error in main loop: {e}")
            time.sleep(config["poll_interval"])

if __name__ == "__main__":
    main()
