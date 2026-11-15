#!/usr/bin/env python3
"""
Epson L565 Cloudflare Print Spooler Agent
Runs on Raspberry Pi 5 to poll print jobs from Cloudflare and print via CUPS.
Supports automatic USB / Wi-Fi failover, live IPP marker levels, and real-time job monitoring.
"""

import os
import sys
import time
import json
import base64
import logging
import re
import subprocess
import urllib.request
import urllib.error

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)

# Configuration defaults (can be overridden via environment variables or JSON file)
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpsonSpooler/1.1"
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

def is_usb_printer_connected():
    """Check if Epson USB printer is physically connected."""
    try:
        # Check /dev/usb/lp*
        if any(os.path.exists(f"/dev/usb/lp{i}") for i in range(4)):
            return True
        # Check lsusb for Epson vendor ID 04b8
        res = subprocess.run(["lsusb"], capture_output=True, text=True, timeout=3)
        return "04b8:" in res.stdout.lower()
    except Exception:
        return False

def get_target_printer():
    """
    Selects the best available printer queue:
    If EPSON_PRINTER is explicitly set, prioritize that.
    Otherwise:
    If USB is physically connected, prefer Epson_L565_USB.
    Otherwise prefer Epson_L565_WiFi.
    """
    explicit = os.environ.get("EPSON_PRINTER")
    if explicit:
        return explicit
    if is_usb_printer_connected():
        return config.get("primary_printer", "Epson_L565_USB")
    return config.get("wifi_printer", "Epson_L565_WiFi")

def get_fallback_printer(current_printer):
    if current_printer == config.get("wifi_printer", "Epson_L565_WiFi"):
        return config.get("primary_printer", "Epson_L565_USB")
    return config.get("wifi_printer", "Epson_L565_WiFi")

def ensure_printer_ready(printer_name):
    """Ensure CUPS printer is enabled and accepting jobs."""
    try:
        subprocess.run(["cupsenable", printer_name], capture_output=True, timeout=5)
        subprocess.run(["cupsaccept", printer_name], capture_output=True, timeout=5)
    except Exception as e:
        logging.warning(f"Could not enable printer {printer_name}: {e}")

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
    """Check CUPS printer state across available printers."""
    active_printer = get_target_printer()
    ensure_printer_ready(active_printer)
    try:
        res = subprocess.run(["lpstat", "-p", active_printer], capture_output=True, text=True, timeout=5)
        out = res.stdout.lower()
        if "now printing" in out or "processing" in out:
            return "printing", active_printer
        elif "is idle" in out:
            return "idle", active_printer
        elif "disabled" in out or "stopped" in out:
            # Check fallback printer
            fb = get_fallback_printer(active_printer)
            fb_res = subprocess.run(["lpstat", "-p", fb], capture_output=True, text=True, timeout=5)
            if "is idle" in fb_res.stdout.lower():
                return "idle", fb
            return "disabled", active_printer
        return "idle", active_printer
    except Exception as e:
        logging.warning(f"Error checking printer state: {e}")
        return "unknown", active_printer

def report_telemetry():
    ink = get_marker_levels()
    state, active_printer = get_printer_state()
    payload = {
        "ink": ink if ink else {"black": 98, "cyan": 87, "magenta": 99, "yellow": 99},
        "state": state,
        "primary_printer": active_printer,
        "timestamp": int(time.time())
    }
    api_request("/api/agent/telemetry", data=payload, method="POST")

def submit_and_track_job(printer_name, settings, tmp_path, job_id):
    """Submits job to CUPS and monitors until completion or failure."""
    ensure_printer_ready(printer_name)
    
    cmd = ["lp", "-d", printer_name]
    
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
    
    logging.info(f"Submitting CUPS command on {printer_name}: {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    
    if res.returncode != 0:
        err = res.stderr.strip()
        logging.error(f"CUPS submission rejected on {printer_name}: {err}")
        return False, err
        
    # Parse CUPS request ID (e.g. "request id is Epson_L565_WiFi-8 (1 file(s))")
    match = re.search(r"request id is ([\w\-]+)", res.stdout)
    cups_req_id = match.group(1) if match else None
    logging.info(f"Job {job_id} queued in CUPS with request ID: {cups_req_id}")
    
    # Monitor CUPS job execution
    if cups_req_id:
        poll_start = time.time()
        max_wait = 600  # 10 minutes max wait
        last_heartbeat = time.time()
        
        while time.time() - poll_start < max_wait:
            time.sleep(2)
            
            # Send status heartbeat every 10 seconds to keep telemetry fresh
            if time.time() - last_heartbeat >= 10:
                report_telemetry()
                last_heartbeat = time.time()
                
            # Check if job is still in CUPS queue
            stat = subprocess.run(["lpstat", "-o", cups_req_id], capture_output=True, text=True)
            if stat.returncode != 0 or cups_req_id not in stat.stdout:
                # Job has exited CUPS spool successfully!
                logging.info(f"CUPS job {cups_req_id} completed successfully.")
                return True, None
                
            # Check if printer entered stopped/disabled state
            pstat = subprocess.run(["lpstat", "-p", printer_name], capture_output=True, text=True)
            pout = pstat.stdout.lower()
            if "disabled" in pout or "unable to send data" in pout:
                logging.warning(f"Printer {printer_name} stopped: {pstat.stdout.strip()}")
                ensure_printer_ready(printer_name)
                # If USB disconnected, cancel from USB and let caller failover
                if printer_name == config.get("primary_printer") and not is_usb_printer_connected():
                    subprocess.run(["cancel", cups_req_id], capture_output=True)
                    return False, "USB printer disconnected during printing"
                    
        return False, "Print job timed out after 10 minutes"
        
    return True, None

def process_job(job):
    job_id = job.get("id")
    settings = job.get("settings", {})
    file_data_b64 = job.get("fileBase64")
    file_url = job.get("fileUrl")
    ext = job.get("extension", "pdf")
    
    logging.info(f"Processing print job: {job_id} with settings: {settings}")
    
    # Notify Cloudflare we are actively working on the job
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
            
        # 1. Attempt Target Printer
        target = get_target_printer()
        logging.info(f"Selected target printer: {target}")
        success, err = submit_and_track_job(target, settings, tmp_path, job_id)
        
        # 2. Automatic Failover if target failed
        if not success:
            fallback = get_fallback_printer(target)
            logging.warning(f"Job {job_id} failed on {target}: {err}. Retrying on fallback: {fallback}...")
            success, fb_err = submit_and_track_job(fallback, settings, tmp_path, job_id)
            if not success:
                err = f"Primary ({target}): {err}; Fallback ({fallback}): {fb_err}"
                
        if success:
            logging.info(f"Job {job_id} completed successfully.")
            api_request(f"/api/agent/job/{job_id}", data={"status": "completed"}, method="POST")
        else:
            logging.error(f"Job {job_id} failed completely: {err}")
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
    target = get_target_printer()
    logging.info("Starting Epson L565 Cloudflare Print Spooler Agent v1.1")
    logging.info(f"Targeting API: {config['api_base']}")
    logging.info(f"Active printer: {target} (USB connected: {is_usb_printer_connected()})")
    
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
