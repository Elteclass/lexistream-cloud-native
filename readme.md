# 🌊 LexiStream: Procesamiento Distribuido Cloud Native

Proyecto final de Programación Web. Sistema de procesamiento asíncrono diseñado para analizar documentos de texto utilizando una arquitectura basada en eventos y contenedores.

## Arquitectura del Sistema
* **Frontend:** HTML, CSS, JavaScript (Plain) con SSE (Server-Sent Events).
* **Backend:** FastAPI (Python asíncrono).
* **Cola de Mensajes:** AWS SQS.
* **Almacenamiento Temporal:** AWS S3.
* **Workers:** 3 contenedores Docker independientes.
* **Caché de Estados:** Redis.

---

## Primeros Pasos (Para el Equipo)

Sigue estos pasos para levantar el proyecto en tu instancia local.

### 1. Clonar el repositorio
```bash
git clone git@github.com:Elteclass/lexistream-cloud-native.git
cd lexistream-cloud-native
```

### 2. Activar el Entorno de Desarrollo (Nix)
Asegúrate de tener Nix instalado. Este comando descargará Python, AWS CLI, Docker y todo lo necesario sin ensuciar tu sistema.

```bash
nix develop
```

### 3. Configurar Variables de Entorno Locales
NUNCA subas tus credenciales a GitHub. Crea un archivo llamado `.env` en la raíz del proyecto (al nivel de `docker-compose.yml`) y agrega lo siguiente **por ejemplo**:

```env
AWS_ACCESS_KEY_ID=tu_access_key_aqui
AWS_SECRET_ACCESS_KEY=tu_secret_key_aqui
AWS_SESSION_TOKEN=tu_session_token_aqui
AWS_DEFAULT_REGION=us-east-1
```

### 4. Levantar la Arquitectura
Con el entorno de Nix activado, construye y levanta todos los microservicios:

```bash
docker compose up --build
```

* **La API estará disponible en:** [http://localhost:8000](http://localhost:8000)
* **La documentación de la API en:** [http://localhost:8000/docs](http://localhost:8000/docs)

---

## 🛠️ Comandos Útiles
* **Apagar el sistema:** Presiona `Ctrl + C` en la terminal donde corre Docker.
* **Limpiar contenedores y red:** 
  ```bash
  docker compose down
  ```
* **Levantar el Frontend localmente:** Abre otra terminal, entra a la carpeta del frontend y levanta un servidor de Python:
  ```bash
  cd frontend
  python -m http.server 3000
  ```
