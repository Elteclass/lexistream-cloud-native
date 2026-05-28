import time
import os
import json
import re
import io
import threading
import asyncio
from collections import Counter
import boto3
import redis
from pypdf import PdfReader

# Extraemos la configuración del entorno inyectada por Docker Compose
worker_id = os.getenv("WORKER_ID", "worker-desconocido")
redis_url = os.getenv("REDIS_URL", "redis://state_cache:6379")
HEARTBEAT_INTERVAL = int(os.getenv("HEARTBEAT_INTERVAL", "5"))
LOGS_CAP = int(os.getenv("WORKER_LOGS_CAP", "200"))

print(f"[{worker_id}] Inicializando clientes AWS y Redis...")

# Inicialización de clientes (S3, SQS y Redis)
sqs = boto3.client('sqs', region_name=os.getenv('AWS_DEFAULT_REGION', 'us-east-1'))
s3 = boto3.client('s3', region_name=os.getenv('AWS_DEFAULT_REGION', 'us-east-1'))
r = redis.from_url(redis_url, decode_responses=True)

QUEUE_URL = os.getenv('SQS_QUEUE_URL')
BUCKET_NAME = os.getenv('S3_BUCKET_NAME')

# Diccionario heuristico para la clasificacion (rapido y sin LLMs)
CATEGORIES = {
    "Technology": ["servidor", "nube", "software", "datos", "código", "red", "api", "tecnología"],
    "Finance": ["inversión", "mercado", "inflación", "capital", "acciones", "dinero", "banco", "finanzas"],
    "Science": ["investigación", "experimento", "molécula", "hipótesis", "laboratorio", "ciencia"]
}

def decode_text_bytes(raw_bytes):
    try:
        return raw_bytes.decode('utf-8')
    except UnicodeDecodeError:
        return raw_bytes.decode('latin-1', errors='ignore')

def extract_text_from_pdf(raw_bytes):
    reader = PdfReader(io.BytesIO(raw_bytes))
    pages_text = []
    for page in reader.pages:
        text = page.extract_text() or ""
        pages_text.append(text)
    return "\n".join(pages_text).strip()

def analyze_text(text):
    words = re.findall(r'\b\w+\b', text.lower())
    char_count = len(text)
    word_count = len(words)
    
    # Filtramos palabras comunes para la gráfica
    stopwords = {"el", "la", "los", "las", "un", "una", "y", "o", "de", "en", "a", "que", "por", "para", "con", "se", "del", "al"}
    filtered_words = [w for w in words if w not in stopwords and len(w) > 2]
    
    top_words = Counter(filtered_words).most_common(3)
    
    topic_scores = {topic: 0 for topic in CATEGORIES}
    for word in filtered_words:
        for topic, keywords in CATEGORIES.items():
            if word in keywords:
                topic_scores[topic] += 1
                
    best_topic = max(topic_scores, key=topic_scores.get)
    if topic_scores[best_topic] == 0:
        best_topic = "General"

    sentences = re.split(r'(?<=[.!?]) +', text)
    summary = " ".join(sentences[:2]) if sentences else text

    return {
        "word_count": word_count,
        "char_count": char_count,
        "topic": best_topic,
        "summary": summary,
        "top_words": top_words
    }

print(f"[{worker_id}] Iniciando y esperando tareas de AWS SQS...")

# Telemetry / heartbeat state
start_time = time.time()
tasks_done = 0
worker_state = 'IDLE'

def push_worker_log(level, message):
    try:
        entry = json.dumps({
            "timestamp": int(time.time()),
            "worker_id": worker_id,
            "state": level,
            "message": message
        })
        key = f"system:workers_logs:{worker_id}"
        r.lpush(key, entry)
        r.ltrim(key, 0, LOGS_CAP - 1)
    except Exception:
        # avoid crashing worker if Redis logging fails
        pass

async def heartbeat_loop():
    while True:
        try:
            uptime = int(time.time() - start_time)
            payload = {
                "worker_id": worker_id,
                "state": worker_state,
                "uptime": uptime,
                "tasks_done": tasks_done,
                "last_seen": int(time.time())
            }
            # store as a hash field for easy snapshotting
            r.hset("system:workers_status", worker_id, json.dumps(payload))
        except Exception:
            pass
        await asyncio.sleep(HEARTBEAT_INTERVAL)

def start_heartbeat():
    def _runner():
        try:
            asyncio.run(heartbeat_loop())
        except Exception:
            return

    t = threading.Thread(target=_runner, daemon=True)
    t.start()

# Start heartbeat background task
start_heartbeat()
push_worker_log('INFO', 'Worker started and waiting for tasks')

while True:
    try:
        # Long Polling a la cola SQS
        response = sqs.receive_message(
            QueueUrl=QUEUE_URL,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=20,
            VisibilityTimeout=60 
        )

        if 'Messages' in response:
            for msg in response['Messages']:
                body = json.loads(msg['Body'])
                task_id = body.get('task_id')
                filename = body.get('filename')

                if not task_id or not filename:
                    # Si el mensaje no tiene el formato esperado, lo borramos para no ciclar
                    sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=msg['ReceiptHandle'])
                    continue

                print(f"[{worker_id}] Procesando tarea: {task_id} | Archivo: {filename}")

                # 1. Mark worker state and update task state in Redis
                worker_state = 'PROCESSING'
                push_worker_log('INFO', f'Starting processing {task_id} ({filename})')
                r.set(task_id, json.dumps({"status": "en proceso"}))

                # 2. Descargar archivo desde S3
                s3_object = s3.get_object(Bucket=BUCKET_NAME, Key=filename)
                raw_bytes = s3_object['Body'].read()

                # 3. Extraer texto segun extension
                ext = os.path.splitext(filename)[-1].lower()
                if ext == '.pdf':
                    text_content = extract_text_from_pdf(raw_bytes)
                else:
                    text_content = decode_text_bytes(raw_bytes)

                # 4. Analizar el texto
                resultados = analyze_text(text_content)

                # 5. Actualizar estado a "completada" con los resultados
                r.set(task_id, json.dumps({
                    "status": "completada",
                    "resultados": resultados
                }))

                # Worker bookkeeping
                tasks_done += 1
                worker_state = 'IDLE'
                push_worker_log('INFO', f'Completed {task_id} successfully')

                # 6. Eliminar el mensaje de la cola para evitar procesamiento duplicado
                sqs.delete_message(
                    QueueUrl=QUEUE_URL,
                    ReceiptHandle=msg['ReceiptHandle']
                )
                print(f"[{worker_id}] Tarea {task_id} finalizada exitosamente.")
        else:
            # Si no hay mensajes, el worker sigue vivo gracias a este pass y WaitTimeSeconds de AWS
            worker_state = 'IDLE'
            # no-op, heartbeat will continue publishing status
            
    except Exception as e:
        print(f"[{worker_id}] Error durante el procesamiento: {str(e)}")
        push_worker_log('ERROR', f'Processing loop error: {str(e)}')
        worker_state = 'DOWN'
        time.sleep(5)