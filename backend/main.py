import os
import json
import time
import uuid
import boto3
import redis
from botocore.exceptions import ClientError, NoCredentialsError
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv

load_dotenv()


app = FastAPI(title="LexiStream API", version="1.0.0")

# Allow the frontend (served as a static file or on a different port) to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_EXTENSIONS = {".txt", ".pdf"}
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB
REDIS_URL = os.getenv("REDIS_URL", "redis://state_cache:6379")

def wait_for_redis(url, timeout=30, interval=1):
    deadline = time.time() + timeout
    last_exc = None
    while time.time() < deadline:
        try:
            client = redis.from_url(url, decode_responses=True)
            client.ping()
            return client
        except Exception as e:
            last_exc = e
            time.sleep(interval)
    raise RuntimeError(f"Could not connect to Redis at {url}: {last_exc}")

REDIS_WAIT_TIMEOUT = int(os.getenv("REDIS_WAIT_TIMEOUT", "30"))
r = wait_for_redis(REDIS_URL, timeout=REDIS_WAIT_TIMEOUT)

# Telemetry config
WORKER_STALE_SECONDS = int(os.getenv("WORKER_STALE_SECONDS", "15"))
LOGS_FETCH_LIMIT = int(os.getenv("LOGS_FETCH_LIMIT", "10"))


@app.get("/")
def read_root():
    return {"status": "LexiStream FastAPI funcionando", "version": "1.0.0"}


@app.get("/api/presigned-url")
def get_presigned_url(
    filename: str = Query(..., description="Name of the file to upload"),
    filesize: int = Query(..., description="Size of the file in bytes"),
):
    """
    Generate a Pre-signed PUT URL for uploading a file directly to S3.
    Validates file extension (.txt / .pdf) and size (<= 10 MB) before issuing the URL.
    """
    # Server-side validation
    ext = os.path.splitext(filename)[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Extensión no permitida: '{ext}'. Solo se aceptan .txt y .pdf.",
        )

    if filesize > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"El archivo supera el límite de 10 MB ({filesize} bytes recibidos).",
        )

    if filesize <= 0:
        raise HTTPException(
            status_code=400,
            detail="El tamaño del archivo debe ser mayor a 0 bytes.",
        )

    # Generate Pre-signed URL
    bucket_name = os.getenv("S3_BUCKET_NAME")
    if not bucket_name:
        raise HTTPException(
            status_code=500,
            detail="Variable de entorno S3_BUCKET_NAME no configurada.",
        )

    try:
        s3_client = boto3.client(
            "s3",
            region_name=os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
        )

        presigned_url = s3_client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": bucket_name,
                "Key": filename,
                "ContentType": "application/octet-stream",
            },
            ExpiresIn=300,  # URL valid for 5 minutes
        )

        return {
            "url": presigned_url,
            "filename": filename,
            "bucket": bucket_name,
            "expires_in": 300,
        }

    except NoCredentialsError:
        raise HTTPException(
            status_code=500,
            detail="Credenciales de AWS no encontradas. Verifica la configuración.",
        )
    except ClientError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error al generar la URL pre-firmada: {e.response['Error']['Message']}",
        )


@app.post("/api/process")
def process_file(payload: dict = Body(...)):
    filename = payload.get("filename")
    if not filename:
        raise HTTPException(status_code=400, detail="Filename es requerido.")

    ext = os.path.splitext(filename)[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Extensión no permitida: '{ext}'. Solo se aceptan .txt y .pdf.",
        )

    queue_url = os.getenv("SQS_QUEUE_URL")
    if not queue_url:
        raise HTTPException(
            status_code=500,
            detail="Variable de entorno SQS_QUEUE_URL no configurada.",
        )

    task_id = str(uuid.uuid4())
    initial_state = {"status": "pendiente", "filename": filename}
    r.set(task_id, json.dumps(initial_state))

    try:
        sqs_client = boto3.client(
            "sqs",
            region_name=os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
        )

        sqs_client.send_message(
            QueueUrl=queue_url,
            MessageBody=json.dumps({"task_id": task_id, "filename": filename}),
        )

        return {"task_id": task_id}
    except NoCredentialsError:
        raise HTTPException(
            status_code=500,
            detail="Credenciales de AWS no encontradas. Verifica la configuración.",
        )
    except ClientError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error al enviar mensaje a SQS: {e.response['Error']['Message']}",
        )


@app.get("/api/stream/{task_id}")
def stream_task(task_id: str):
    if not r.get(task_id):
        raise HTTPException(status_code=404, detail="Task ID no encontrado.")

    def event_generator():
        last_payload = None
        while True:
            payload = r.get(task_id)
            if payload and payload != last_payload:
                last_payload = payload
                yield f"data: {payload}\n\n"
            time.sleep(1)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/system-telemetry/snapshot")
def telemetry_snapshot():
    """Return a JSON snapshot of current workers read from Redis.

    The Redis hash `system:workers_status` is expected to contain per-worker JSON payloads.
    """
    try:
        raw = r.hgetall("system:workers_status") or {}
        workers = []
        now_ts = int(time.time())
        for wid, payload in raw.items():
            try:
                obj = json.loads(payload)
            except Exception:
                # skip malformed entries
                continue
            # mark stale workers as DOWN
            last = int(obj.get("last_seen", 0))
            if now_ts - last > WORKER_STALE_SECONDS:
                obj["state"] = "DOWN"
            workers.append(obj)

        return {"workers": workers}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Telemetry snapshot error: {str(e)}")


@app.get("/api/system-telemetry")
def system_telemetry():
    """SSE stream that emits `telemetry` events (fleet snapshot) and `log` events (per-worker latest logs).

    Polls Redis regularly and yields SSE events when changes are observed.
    """
    def event_generator():
        last_snapshot = None
        seen_log_count_by_worker = {}

        try:
            while True:
                try:
                    raw = r.hgetall("system:workers_status") or {}
                    now_ts = int(time.time())
                    workers = []

                    for wid, payload in raw.items():
                        try:
                            obj = json.loads(payload)
                        except Exception:
                            continue
                        last = int(obj.get("last_seen", 0))
                        if now_ts - last > WORKER_STALE_SECONDS:
                            obj["state"] = "DOWN"
                        workers.append(obj)

                    snapshot = {"workers": workers}

                    snap_text = json.dumps(snapshot, sort_keys=True)
                    if snap_text != last_snapshot:
                        last_snapshot = snap_text
                        yield f"event: telemetry\ndata: {snap_text}\n\n"

                    # Check per-worker latest log entries without replaying old ones.
                    for w in workers:
                        wid = w.get("worker_id")
                        if not wid:
                            continue
                        key = f"system:workers_logs:{wid}"
                        try:
                            entries = r.lrange(key, 0, LOGS_FETCH_LIMIT - 1) or []
                        except Exception:
                            entries = []

                        previous_count = seen_log_count_by_worker.get(wid)

                        # First time we see a worker, emit the current window once so
                        # the dashboard can show the existing log stream immediately.
                        if previous_count is None:
                            if entries:
                                for raw_entry in reversed(entries):
                                    if not raw_entry:
                                        continue
                                    try:
                                        entry_obj = json.loads(raw_entry)
                                    except Exception:
                                        entry_obj = {"message": raw_entry}

                                    yield f"event: log\ndata: {json.dumps(entry_obj)}\n\n"

                            seen_log_count_by_worker[wid] = len(entries)
                            continue

                        if len(entries) > previous_count:
                            new_entries = entries[: len(entries) - previous_count]

                            # Emit in chronological order among the newly received items.
                            for raw_entry in reversed(new_entries):
                                if not raw_entry:
                                    continue
                                try:
                                    entry_obj = json.loads(raw_entry)
                                except Exception:
                                    entry_obj = {"message": raw_entry}

                                yield f"event: log\ndata: {json.dumps(entry_obj)}\n\n"

                        seen_log_count_by_worker[wid] = len(entries)

                except GeneratorExit:
                    break
                except Exception:
                    # Avoid bubbling errors to the client; continue polling
                    pass

                time.sleep(1)
        finally:
            return

    return StreamingResponse(event_generator(), media_type="text/event-stream")