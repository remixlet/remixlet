{
  description = "remixlet development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = [
            # Dev-env tooling
            pkgs.bash
            pkgs.go-task

            # Node deps
            pkgs.nodejs_24
            pkgs.corepack_24

            # Integration tests drive a real Chrome over CDP
            pkgs.pkg-config
          ];

          shellHook = ''
            set -e

            echo ""
            echo ""
            echo "                          _      _      _   "
            echo "      _ __ ___ _ __ ___ (_)_  _| | ___| |_  "
            echo "     | '__/ _ \\ '_ \` _ \\| \\ \\/ / |/ _ \\ __| "
            echo "     | | |  __/ | | | | | |>  <| |  __/ |_  "
            echo "     |_|  \\___|_| |_| |_|_/_/\\_\\_|\\___|\\__| "
            echo ""
            echo "      Node `node --version`"
            echo ""
          '';
        };
      });
}
