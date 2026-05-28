import time
import os
import json
import re
from collections import Counter
import boto3
import redis

# Extraemos la configuración del entorno inyectada por Docker Compose
worker_id = os.getenv("WORKER_ID", "worker-desconocido")
redis_url = os.getenv("REDIS_URL", "redis://state_cache:6379")

print(f"[{worker_id}] Inicializando clientes AWS y Redis...")

# Inicialización de clientes (S3, SQS y Redis)
sqs = boto3.client('sqs', region_name=os.getenv('AWS_DEFAULT_REGION', 'us-east-1'))
s3 = boto3.client('s3', region_name=os.getenv('AWS_DEFAULT_REGION', 'us-east-1'))
r = redis.from_url(redis_url, decode_responses=True)

QUEUE_URL = os.getenv('SQS_QUEUE_URL')
BUCKET_NAME = os.getenv('S3_BUCKET_NAME')

# Diccionario heurístico para la clasificación (rápido y sin LLMs)
CATEGORIES = {
    "Technology": ["servidor", "nube", "software", "datos", "código", "red", "api", "tecnología"],
    "Finance": ["inversión", "mercado", "inflación", "capital", "acciones", "dinero", "banco", "finanzas"],
    "Science": ["investigación", "experimento", "molécula", "hipótesis", "laboratorio", "ciencia"]
}

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

                # 1. Actualizar estado a "en proceso" en Redis
                r.set(task_id, json.dumps({"status": "en proceso"}))

                # 2. Descargar archivo desde S3
                s3_object = s3.get_object(Bucket=BUCKET_NAME, Key=filename)
                text_content = s3_object['Body'].read().decode('utf-8')

                # 3. Analizar el texto
                resultados = analyze_text(text_content)

                # 4. Actualizar estado a "completada" con los resultados
                r.set(task_id, json.dumps({
                    "status": "completada",
                    "resultados": resultados
                }))

                # 5. Eliminar el mensaje de la cola para evitar procesamiento duplicado
                sqs.delete_message(
                    QueueUrl=QUEUE_URL,
                    ReceiptHandle=msg['ReceiptHandle']
                )
                print(f"[{worker_id}] Tarea {task_id} finalizada exitosamente.")
        else:
            # Si no hay mensajes, el worker sigue vivo gracias a este pass y WaitTimeSeconds de AWS
            pass
            
    except Exception as e:
        print(f"[{worker_id}] Error durante el procesamiento: {str(e)}")
        time.sleep(5)