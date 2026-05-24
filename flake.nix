{
  description = "Entorno LexiStream Cloud Native";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          python312
          python312Packages.fastapi
          python312Packages.uvicorn
          python312Packages.boto3
          python312Packages.redis
          python312Packages.pip
          awscli2
          docker
          docker-compose
          redis
          git curl
        ];

        shellHook = ''
          export VENV_DIR="$PWD/.venv"
          if [ ! -d "$VENV_DIR" ]; then
            echo "⚙️ Inicializando entorno virtual en $VENV_DIR..."
            python -m venv $VENV_DIR
          fi
          source $VENV_DIR/bin/activate
          echo "==================================================="
          echo "🌊 Entorno LexiStream activado (Python: $(python --version)) 🌊"
          echo "==================================================="
        '';
      };
    };
}