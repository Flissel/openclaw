#!/usr/bin/env bash
#
# setup-hotel.sh - Complete Hotel Concierge Setup
#
# Sets up everything from scratch:
#   1. Generate secure gateway token
#   2. Create data directories
#   3. Write openclaw.json config
#   4. Build Docker image (with hotel-concierge extension)
#   5. Start all services (OpenClaw, Qdrant, Ollama)
#   6. Wait for Ollama to pull models
#   7. Load seed data for Wasserburg am Inn
#   8. Print access URLs and next steps
#
# Prerequisites: Docker, Docker Compose, NVIDIA GPU (recommended)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_header() {
  echo ""
  echo -e "${CYAN}╔════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}$1${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════════════════╝${NC}"
  echo ""
}

print_step() {
  echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} ${BOLD}$1${NC}"
}

print_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

print_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

# ============================================================================
# Pre-flight checks
# ============================================================================

print_header "Hotel Concierge - Vollstaendiges Setup"

print_step "Pruefe Voraussetzungen..."

# Docker
if ! command -v docker &> /dev/null; then
  print_error "Docker ist nicht installiert."
  echo "Installiere Docker Desktop: https://www.docker.com/products/docker-desktop/"
  exit 1
fi
print_info "Docker: $(docker --version)"

# Docker Compose
if ! docker compose version &> /dev/null; then
  print_error "Docker Compose ist nicht verfuegbar."
  exit 1
fi
print_info "Compose: $(docker compose version)"

# NVIDIA GPU
GPU_AVAILABLE=false
if nvidia-smi &> /dev/null; then
  GPU_AVAILABLE=true
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null | head -1)
  GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  print_info "GPU: $GPU_NAME (${GPU_MEM} MiB)"
else
  print_warn "Keine NVIDIA GPU gefunden. Ollama laeuft auf CPU (langsamer)."
  print_warn "Fuer GPU-Support: NVIDIA-Treiber + NVIDIA Container Toolkit installieren."
fi

# ============================================================================
# Generate token
# ============================================================================

print_step "Generiere Gateway-Token..."

ENV_FILE="${SCRIPT_DIR}/.env.hotel"

if [ -f "$ENV_FILE" ]; then
  print_info "Bestehende .env.hotel gefunden, verwende existierenden Token."
  # shellcheck source=/dev/null
  source "$ENV_FILE" 2>/dev/null || true
else
  OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 48)
  cat > "$ENV_FILE" << EOF
# Hotel Concierge - Auto-generated $(date +%Y-%m-%d)
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
TZ=Europe/Berlin
EOF
  print_info "Token generiert und in .env.hotel gespeichert."
fi

# Re-source to ensure token is available
# shellcheck source=/dev/null
source "$ENV_FILE" 2>/dev/null || true
export OPENCLAW_GATEWAY_TOKEN

# ============================================================================
# Create data directories
# ============================================================================

print_step "Erstelle Datenverzeichnisse..."

mkdir -p data/openclaw data/qdrant data/ollama data/openclaw/hotel-concierge

# ============================================================================
# Write openclaw.json config
# ============================================================================

print_step "Schreibe openclaw.json Konfiguration..."

CONFIG_FILE="data/openclaw/openclaw.json"

if [ -f "$CONFIG_FILE" ]; then
  print_info "Bestehende openclaw.json gefunden - wird nicht ueberschrieben."
  print_info "Zum Zuruecksetzen: rm $CONFIG_FILE"
else
  cp hotel-setup/openclaw.hotel.json "$CONFIG_FILE"
  print_info "Config geschrieben: $CONFIG_FILE"
fi

# ============================================================================
# Handle GPU/CPU docker-compose
# ============================================================================

COMPOSE_FILE="docker-compose.hotel.yml"

if [ "$GPU_AVAILABLE" = false ]; then
  print_step "Erstelle CPU-only docker-compose Override..."
  cat > docker-compose.hotel.override.yml << 'OVERRIDE'
services:
  ollama:
    deploy:
      resources: {}
OVERRIDE
  COMPOSE_CMD="docker compose -f $COMPOSE_FILE -f docker-compose.hotel.override.yml --env-file .env.hotel"
  print_info "GPU-Reservierung deaktiviert (CPU-only Modus)."
else
  COMPOSE_CMD="docker compose -f $COMPOSE_FILE --env-file .env.hotel"
  # Clean up any leftover override
  rm -f docker-compose.hotel.override.yml
fi

# ============================================================================
# Build Docker image
# ============================================================================

print_header "Docker Image bauen"
print_step "Baue openclaw-hotel:local (das dauert beim ersten Mal 5-10 Minuten)..."

$COMPOSE_CMD build openclaw-gateway 2>&1 | tail -5

print_info "Image gebaut."

# ============================================================================
# Start services
# ============================================================================

print_header "Services starten"

print_step "Starte Qdrant + Ollama..."
$COMPOSE_CMD up -d qdrant ollama

print_step "Warte auf Qdrant..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:6333/readyz > /dev/null 2>&1; then
    print_info "Qdrant ist bereit."
    break
  fi
  if [ "$i" = "30" ]; then
    print_error "Qdrant startet nicht. Pruefe: docker compose -f $COMPOSE_FILE logs qdrant"
    exit 1
  fi
  sleep 2
done

print_step "Warte auf Ollama (GPU-Initialisierung kann dauern)..."
for i in $(seq 1 90); do
  if curl -sf http://localhost:${OLLAMA_PORT:-11434}/api/tags > /dev/null 2>&1; then
    print_info "Ollama ist bereit."
    break
  fi
  if [ "$i" = "90" ]; then
    print_error "Ollama startet nicht. Pruefe: $COMPOSE_CMD logs ollama"
    exit 1
  fi
  sleep 2
done

# ============================================================================
# Pull Ollama models
# ============================================================================

print_header "Ollama Modelle laden"

print_step "Lade nomic-embed-text (Embedding-Modell, ~274 MB)..."
curl -sf http://localhost:${OLLAMA_PORT:-11434}/api/pull -d '{"name":"nomic-embed-text","stream":false}' > /dev/null 2>&1 || {
  print_warn "Streaming-Pull fuer nomic-embed-text..."
  curl -s http://localhost:${OLLAMA_PORT:-11434}/api/pull -d '{"name":"nomic-embed-text"}' | tail -1
}
print_info "nomic-embed-text bereit."

print_step "Lade llama3.1:8b (Chat-Modell, ~4.7 GB - das dauert!)..."
print_info "Download laeuft... Bitte warten."
curl -sf http://localhost:${OLLAMA_PORT:-11434}/api/pull -d '{"name":"llama3.1:8b","stream":false}' > /dev/null 2>&1 || {
  print_warn "Streaming-Pull fuer llama3.1:8b..."
  curl -s http://localhost:${OLLAMA_PORT:-11434}/api/pull -d '{"name":"llama3.1:8b"}' | tail -1
}
print_info "llama3.1:8b bereit."

# Verify models
print_step "Pruefe geladene Modelle..."
curl -sf http://localhost:${OLLAMA_PORT:-11434}/api/tags | grep -o '"name":"[^"]*"' | while read -r line; do
  print_info "  Modell: $line"
done

# ============================================================================
# Start OpenClaw gateway
# ============================================================================

print_header "OpenClaw Gateway starten"

print_step "Starte openclaw-gateway..."
$COMPOSE_CMD up -d openclaw-gateway

print_step "Warte auf Gateway (kann bis zu 60s dauern)..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:18789/healthz > /dev/null 2>&1; then
    print_info "Gateway ist bereit!"
    break
  fi
  if [ "$i" = "60" ]; then
    print_warn "Gateway braucht laenger als erwartet."
    print_info "Pruefe Status: $COMPOSE_CMD logs openclaw-gateway"
    print_info "Fortsetze trotzdem..."
    break
  fi
  sleep 2
done

# ============================================================================
# Load seed data
# ============================================================================

print_header "Wasserburg am Inn Seed-Daten laden"

print_step "Lade Hotel-Informationen in die Wissensdatenbank..."

# Wait a bit more for the gateway to fully initialize plugins
sleep 5

SEED_DIR="hotel-setup/seed-data"
uploaded=0
failed=0

for filepath in "$SEED_DIR"/*.txt; do
  [ -f "$filepath" ] || continue
  filename="$(basename "$filepath")"

  # Map filename to category
  case "$filename" in
    hotel-info*) category="hotel_info" ;;
    faq*) category="faq" ;;
    restaurant*) category="dining" ;;
    event*) category="events" ;;
    transport*) category="transport" ;;
    wasserburg*) category="local" ;;
    *) category="other" ;;
  esac

  echo -n "  Uploading: $filename ($category) ... "

  response=$(curl -sf \
    -X POST \
    -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
    -F "file=@${filepath}" \
    -F "category=${category}" \
    "http://localhost:18789/concierge/admin/upload" 2>&1) || {
      echo -e "${RED}FEHLER${NC}"
      failed=$((failed + 1))
      continue
    }

  if echo "$response" | grep -q '"success":true'; then
    chunks=$(echo "$response" | grep -o '"chunks":[0-9]*' | grep -o '[0-9]*' || echo "?")
    echo -e "${GREEN}OK${NC} ($chunks Chunks)"
    uploaded=$((uploaded + 1))
  else
    echo -e "${RED}FEHLER${NC}"
    echo "    $response"
    failed=$((failed + 1))
  fi
done

echo ""
print_info "Seed-Daten: $uploaded hochgeladen, $failed fehlgeschlagen."

# ============================================================================
# Get local IP for QR code
# ============================================================================

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig 2>/dev/null | grep -oP 'IPv4.*?: \K[\d.]+' | head -1 || echo "localhost")

# ============================================================================
# Summary
# ============================================================================

print_header "Setup abgeschlossen!"

echo -e "${BOLD}Services:${NC}"
echo -e "  Qdrant:    ${GREEN}http://localhost:6333/dashboard${NC}"
echo -e "  Ollama:    ${GREEN}http://localhost:11434${NC}"
echo -e "  Gateway:   ${GREEN}http://localhost:18789${NC}"
echo ""
echo -e "${BOLD}Hotel Concierge URLs:${NC}"
echo -e "  Gast-Registrierung:  ${CYAN}http://${LOCAL_IP}:18789/concierge/register${NC}"
echo -e "  Admin-Panel:         ${CYAN}http://localhost:18789/concierge/admin${NC}"
echo -e "  Qdrant Dashboard:    ${CYAN}http://localhost:6333/dashboard${NC}"
echo ""
echo -e "${BOLD}Gateway Token:${NC} ${YELLOW}${OPENCLAW_GATEWAY_TOKEN}${NC}"
echo -e "  (gespeichert in .env.hotel)"
echo ""
echo -e "${BOLD}Naechste Schritte:${NC}"
echo ""
echo -e "  ${BOLD}1. WhatsApp verbinden:${NC}"
echo -e "     ${CYAN}docker compose -f docker-compose.hotel.yml --env-file .env.hotel exec openclaw-gateway openclaw channels login --channel whatsapp${NC}"
echo -e "     -> QR-Code mit dem Handy scannen (WhatsApp > Verknuepfte Geraete)"
echo ""
echo -e "  ${BOLD}2. QR-Code fuer Hotel-Lobby drucken:${NC}"
echo -e "     URL: ${CYAN}http://${LOCAL_IP}:18789/concierge/register${NC}"
echo -e "     -> QR-Code generieren z.B. mit: https://www.qrcode-generator.de/"
echo ""
echo -e "  ${BOLD}3. Testen:${NC}"
echo -e "     a) Registrierungsseite oeffnen: http://localhost:18789/concierge/register"
echo -e "     b) Telefonnummer eingeben und registrieren"
echo -e "     c) WhatsApp-Nachricht an die Bot-Nummer senden"
echo -e "     d) Fragen stellen: 'Was gibt es in Wasserburg zu sehen?'"
echo ""
echo -e "  ${BOLD}4. Weitere Dokumente hochladen:${NC}"
echo -e "     Admin-Panel: http://localhost:18789/concierge/admin"
echo -e "     (Token fuer Authentifizierung: siehe oben)"
echo ""
echo -e "${BOLD}Nuetzliche Befehle:${NC}"
echo "  Status:   docker compose -f docker-compose.hotel.yml --env-file .env.hotel ps"
echo "  Logs:     docker compose -f docker-compose.hotel.yml --env-file .env.hotel logs -f"
echo "  Stoppen:  docker compose -f docker-compose.hotel.yml --env-file .env.hotel down"
echo "  Neustart: docker compose -f docker-compose.hotel.yml --env-file .env.hotel restart"
echo ""
