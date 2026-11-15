/**
 * Epson L565 Cloudflare Print Spooler Worker
 * Provides cloud spooling queue, agent polling, telemetry, and serves the PWA.
 */

export interface Env {
  EPSON_PRINT_JOBS: KVNamespace;
  AGENT_SECRET: string;
  ASSETS: Fetcher;
}

interface PrintSettings {
  pageSize: string;
  mediaType: string;
  ink: string;
  copies: number;
  orientation: string;
  fitToPage: boolean;
  pageRange: string;
}

interface JobMetadata {
  id: string;
  filename: string;
  extension: string;
  contentType: string;
  size: number;
  settings: PrintSettings;
  status: 'queued' | 'downloading' | 'printing' | 'completed' | 'failed';
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface TelemetryData {
  ink: {
    black: number;
    cyan: number;
    magenta: number;
    yellow: number;
  };
  state: 'idle' | 'printing' | 'disabled' | 'offline' | 'unknown';
  primary_printer: string;
  markerTime?: string;
  updatedAt: string;
  timestamp?: number;
  isOnline?: boolean;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Secret, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message, success: false }, status);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32KB chunks
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Route API requests
    if (pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Internal Server Error: ${message}`, 500);
      }
    }

    // Serve static assets from public/ directory
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  // 1. POST /api/print - Submit new print job
  if (pathname === '/api/print' && method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    let fileBytes: ArrayBuffer | null = null;
    let filename = '';
    let mimeType = 'application/octet-stream';

    // Parse Settings with defaults
    let settings: PrintSettings = {
      pageSize: 'A4',
      mediaType: 'PLAIN_NORMAL',
      ink: 'COLOR',
      copies: 1,
      orientation: 'auto',
      fitToPage: true,
      pageRange: 'All',
    };

    if (contentType.includes('application/json')) {
      const body = (await request.json().catch(() => ({}))) as {
        fileBase64?: string;
        filename?: string;
        contentType?: string;
        settings?: Partial<PrintSettings>;
      };

      if (!body.fileBase64) {
        return errorResponse('Missing fileBase64 in request body', 400);
      }

      filename = body.filename || `document_${Date.now()}.pdf`;
      mimeType = body.contentType || 'application/pdf';
      if (body.settings && typeof body.settings === 'object') {
        settings = { ...settings, ...body.settings };
      }

      // Decode base64 to ArrayBuffer
      try {
        const base64Data = body.fileBase64.replace(/^data:[^;]+;base64,/, '');
        const binaryString = atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        fileBytes = bytes.buffer;
      } catch (decodeErr: unknown) {
        const msg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
        return errorResponse(`Invalid base64 payload: ${msg}`, 400);
      }
    } else if (contentType.includes('multipart/form-data')) {
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch (formErr: unknown) {
        const msg = formErr instanceof Error ? formErr.message : String(formErr);
        return errorResponse(`Malformed multipart upload: ${msg}. Try uploading again.`, 400);
      }

      const fileEntry = formData.get('file');
      if (!fileEntry || typeof fileEntry === 'string') {
        return errorResponse('No file uploaded or file is empty', 400);
      }
      const file = fileEntry as unknown as File;
      if (!file.size || file.size === 0) {
        return errorResponse('Uploaded file is empty', 400);
      }

      filename = file.name || `document_${Date.now()}.pdf`;
      mimeType = file.type || 'application/octet-stream';
      fileBytes = await file.arrayBuffer();

      const settingsRaw = formData.get('settings');
      if (typeof settingsRaw === 'string') {
        try {
          const parsed = JSON.parse(settingsRaw);
          settings = { ...settings, ...parsed };
        } catch {
          // Fall back to defaults or individual form fields
        }
      } else {
        if (formData.has('pageSize')) settings.pageSize = String(formData.get('pageSize'));
        if (formData.has('mediaType')) settings.mediaType = String(formData.get('mediaType'));
        if (formData.has('ink')) settings.ink = String(formData.get('ink'));
        if (formData.has('copies')) settings.copies = Math.max(1, parseInt(String(formData.get('copies')), 10) || 1);
        if (formData.has('orientation')) settings.orientation = String(formData.get('orientation'));
        if (formData.has('fitToPage')) settings.fitToPage = String(formData.get('fitToPage')) === 'true';
        if (formData.has('pageRange')) settings.pageRange = String(formData.get('pageRange'));
      }
    } else {
      return errorResponse('Content-Type must be multipart/form-data or application/json', 400);
    }

    if (!fileBytes || fileBytes.byteLength === 0) {
      return errorResponse('No file uploaded or file is empty', 400);
    }

    // Check file size (KV limit is 25MB per value)
    if (fileBytes.byteLength > 25 * 1024 * 1024) {
      return errorResponse('File exceeds 25MB size limit', 400);
    }

    // Generate unique Job ID
    const randomHex = Math.random().toString(36).substring(2, 9);
    const jobId = `job_${Date.now()}_${randomHex}`;

    // Extract filename and extension
    const parts = filename.split('.');
    const extension = parts.length > 1 ? (parts.pop()?.toLowerCase() || 'pdf') : 'pdf';

    // Save raw file in KV with 1-hour expiration
    await env.EPSON_PRINT_JOBS.put(`file:${jobId}`, fileBytes, {
      expirationTtl: 3600,
    });

    // Save job metadata
    const jobMetadata: JobMetadata = {
      id: jobId,
      filename,
      extension,
      contentType: mimeType,
      size: fileBytes.byteLength,
      settings,
      status: 'queued',
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await env.EPSON_PRINT_JOBS.put(`job:${jobId}`, JSON.stringify(jobMetadata));

    // Append to print queue
    let queue: string[] = (await env.EPSON_PRINT_JOBS.get('queue', { type: 'json' })) || [];
    if (!Array.isArray(queue)) queue = [];
    queue.push(jobId);
    await env.EPSON_PRINT_JOBS.put('queue', JSON.stringify(queue));

    return jsonResponse({
      success: true,
      jobId,
      message: 'Print job queued successfully',
      queuePosition: queue.length,
    });
  }

  // 2. GET /api/status/:id - Query job status
  if (pathname.startsWith('/api/status/') && method === 'GET') {
    const jobId = pathname.replace('/api/status/', '').trim();
    if (!jobId) return errorResponse('Missing job ID', 400);

    const job = await env.EPSON_PRINT_JOBS.get<JobMetadata>(`job:${jobId}`, { type: 'json' });
    if (!job) {
      return errorResponse('Job not found or expired', 404);
    }

    return jsonResponse({
      success: true,
      id: job.id,
      status: job.status,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      filename: job.filename,
      size: job.size,
      settings: job.settings,
    });
  }

  // 3. GET /api/agent/poll - Agent polls for next job
  if (pathname === '/api/agent/poll' && method === 'GET') {
    const authHeader = request.headers.get('X-Agent-Secret');
    if (authHeader !== env.AGENT_SECRET) {
      return errorResponse('Unauthorized: Invalid agent secret', 401);
    }

    let queue: string[] = (await env.EPSON_PRINT_JOBS.get('queue', { type: 'json' })) || [];
    if (!Array.isArray(queue) || queue.length === 0) {
      return jsonResponse({ job: null });
    }

    // Find the first valid pending job
    let candidateJob: JobMetadata | null = null;
    let candidateId: string | null = null;
    const remainingQueue: string[] = [];
    const now = Date.now();

    for (const qId of queue) {
      const j = await env.EPSON_PRINT_JOBS.get<JobMetadata>(`job:${qId}`, { type: 'json' });
      if (!j || j.status === 'completed' || j.status === 'failed') {
        // Prune completed/failed/missing jobs from queue
        continue;
      }

      // Check if job is pending initial dispatch
      if (!candidateJob && j.status === 'queued') {
        candidateJob = j;
        candidateId = qId;
      } else if (!candidateJob && j.status === 'downloading') {
        // If downloading for more than 90 seconds without transitioning to printing, re-dispatch
        const jobAge = now - new Date(j.createdAt).getTime();
        if (jobAge > 90000) {
          candidateJob = j;
          candidateId = qId;
        }
      }

      remainingQueue.push(qId);
    }

    // Save cleaned queue if entries were pruned
    if (remainingQueue.length !== queue.length) {
      await env.EPSON_PRINT_JOBS.put('queue', JSON.stringify(remainingQueue));
    }

    if (!candidateJob || !candidateId) {
      return jsonResponse({ job: null });
    }

    // Fetch file bytes
    const fileBuffer = await env.EPSON_PRINT_JOBS.get(`file:${candidateId}`, { type: 'arrayBuffer' });
    let fileBase64: string | null = null;
    if (fileBuffer) {
      fileBase64 = arrayBufferToBase64(fileBuffer);
    }

    const fileUrl = `${url.origin}/api/agent/file/${candidateId}?token=${encodeURIComponent(env.AGENT_SECRET)}`;

    // Update job status to 'downloading'
    candidateJob.status = 'downloading';
    await env.EPSON_PRINT_JOBS.put(`job:${candidateId}`, JSON.stringify(candidateJob));

    return jsonResponse({
      job: {
        id: candidateJob.id,
        filename: candidateJob.filename,
        extension: candidateJob.extension || 'pdf',
        settings: candidateJob.settings,
        fileBase64,
        fileUrl,
      },
    });
  }

  // 4. GET /api/agent/file/:id - Agent downloads raw file payload
  if (pathname.startsWith('/api/agent/file/') && method === 'GET') {
    const authHeader = request.headers.get('X-Agent-Secret');
    const queryToken = url.searchParams.get('token');
    if (authHeader !== env.AGENT_SECRET && queryToken !== env.AGENT_SECRET) {
      return errorResponse('Unauthorized: Invalid agent secret', 401);
    }

    const jobId = pathname.replace('/api/agent/file/', '').trim();
    if (!jobId) return errorResponse('Missing job ID', 400);

    const [job, fileBuffer] = await Promise.all([
      env.EPSON_PRINT_JOBS.get<JobMetadata>(`job:${jobId}`, { type: 'json' }),
      env.EPSON_PRINT_JOBS.get(`file:${jobId}`, { type: 'arrayBuffer' }),
    ]);

    if (!fileBuffer) {
      return errorResponse('File not found or expired', 404);
    }

    return new Response(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': job?.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${job?.filename || 'print_document'}"`,
        ...CORS_HEADERS,
      },
    });
  }

  // 5. POST /api/agent/job/:id - Agent updates job status
  if (pathname.startsWith('/api/agent/job/') && method === 'POST') {
    const authHeader = request.headers.get('X-Agent-Secret');
    if (authHeader !== env.AGENT_SECRET) {
      return errorResponse('Unauthorized: Invalid agent secret', 401);
    }

    const jobId = pathname.replace('/api/agent/job/', '').trim();
    if (!jobId) return errorResponse('Missing job ID', 400);

    const body = (await request.json().catch(() => ({}))) as { status?: string; error?: string };
    const { status, error } = body;

    const job = await env.EPSON_PRINT_JOBS.get<JobMetadata>(`job:${jobId}`, { type: 'json' });
    if (!job) {
      return errorResponse('Job not found', 404);
    }

    if (status === 'printing') {
      job.status = 'printing';
    } else if (status === 'completed') {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.error = null;
      // Clean up file bytes from KV
      await env.EPSON_PRINT_JOBS.delete(`file:${jobId}`);
      // Remove from queue
      let queue: string[] = (await env.EPSON_PRINT_JOBS.get('queue', { type: 'json' })) || [];
      queue = queue.filter((id) => id !== jobId);
      await env.EPSON_PRINT_JOBS.put('queue', JSON.stringify(queue));
    } else if (status === 'failed') {
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.error = error || 'Print job failed';
      // Clean up file bytes
      await env.EPSON_PRINT_JOBS.delete(`file:${jobId}`);
      // Remove from queue
      let queue: string[] = (await env.EPSON_PRINT_JOBS.get('queue', { type: 'json' })) || [];
      queue = queue.filter((id) => id !== jobId);
      await env.EPSON_PRINT_JOBS.put('queue', JSON.stringify(queue));
    }

    await env.EPSON_PRINT_JOBS.put(`job:${jobId}`, JSON.stringify(job));
    return jsonResponse({ success: true, status: job.status });
  }

  // 6. POST /api/agent/telemetry - Agent reports ink & printer state
  if (pathname === '/api/agent/telemetry' && method === 'POST') {
    const authHeader = request.headers.get('X-Agent-Secret');
    if (authHeader !== env.AGENT_SECRET) {
      return errorResponse('Unauthorized: Invalid agent secret', 401);
    }

    const body = (await request.json().catch(() => ({}))) as Partial<TelemetryData>;
    const defaultInk = { black: 99, cyan: 88, magenta: 100, yellow: 100 };

    const telemetry: TelemetryData = {
      ink: body.ink ? { ...defaultInk, ...body.ink } : defaultInk,
      state: (body.state as TelemetryData['state']) || 'idle',
      primary_printer: body.primary_printer || 'Epson_L565_USB',
      markerTime: body.markerTime || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      timestamp: body.timestamp || Math.floor(Date.now() / 1000),
    };

    await env.EPSON_PRINT_JOBS.put('telemetry', JSON.stringify(telemetry));
    return jsonResponse({ success: true, telemetry });
  }

  // 7. GET /api/telemetry - Public live telemetry endpoint
  if (pathname === '/api/telemetry' && method === 'GET') {
    let telemetry = await env.EPSON_PRINT_JOBS.get<TelemetryData>('telemetry', { type: 'json' });

    if (!telemetry) {
      telemetry = {
        ink: { black: 95, cyan: 88, magenta: 92, yellow: 90 },
        state: 'idle',
        primary_printer: 'Epson_L565_USB',
        markerTime: 'Initial Ready',
        updatedAt: new Date().toISOString(),
        isOnline: true,
      };
    } else {
      // Determine if printer agent has reported within the last 90 seconds
      const lastUpdate = new Date(telemetry.updatedAt).getTime();
      const ageSeconds = (Date.now() - lastUpdate) / 1000;
      telemetry.isOnline = ageSeconds < 90;
      if (!telemetry.isOnline && telemetry.state !== 'printing') {
        telemetry.state = 'offline';
      }
    }

    return jsonResponse(telemetry, 200, {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
  }

  // 8. GET /api/queue - Inspect active queue
  if (pathname === '/api/queue' && method === 'GET') {
    const queue: string[] = (await env.EPSON_PRINT_JOBS.get('queue', { type: 'json' })) || [];
    return jsonResponse({ queue, count: queue.length });
  }

  // 9. POST /api/queue/clear - Cancel and purge all queued jobs
  if ((pathname === '/api/queue/clear' || pathname === '/api/queue') && method === 'POST') {
    const queue: string[] = (await env.EPSON_PRINT_JOBS.get('queue', { type: 'json' })) || [];
    for (const qId of queue) {
      await Promise.all([
        env.EPSON_PRINT_JOBS.delete(`file:${qId}`),
        env.EPSON_PRINT_JOBS.put(`job:${qId}`, JSON.stringify({ status: 'failed', error: 'Canceled by user' })),
      ]);
    }
    await env.EPSON_PRINT_JOBS.put('queue', JSON.stringify([]));
    return jsonResponse({ success: true, message: `Purged ${queue.length} jobs from queue` });
  }

  return errorResponse('Not Found', 404);
}
