import time
import os

worker_id = os.getenv("WORKER_ID", "worker-desconocido")

print(f"[{worker_id}] Iniciando y esperando tareas...")

while True:
    time.sleep(10) # Simula estar escuchando la cola