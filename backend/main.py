import os
import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
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