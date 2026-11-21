#!/usr/bin/env bash
# 원본 자료를 raw/ 에 내려받는다. (raw/ 는 저장소에 올리지 않는다)
#   - 수심 격자: GMRT Synthesis GridServer (https://www.gmrt.org)
#   - 독도 해안선, 서울특별시 경계: OpenStreetMap (Nominatim)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p raw
UA="bathymetry-viz/1.0"

curl -fsS -m 300 -o raw/gmrt_dokdo.asc \
  "https://www.gmrt.org/services/GridServer?minlongitude=131.4&maxlongitude=132.6&minlatitude=36.8&maxlatitude=37.6&format=esriascii&resolution=high"

# Nominatim 은 1초에 한 번만 요청한다
curl -fsS -m 60 -A "$UA" -o raw/dokdo_osm.json -G "https://nominatim.openstreetmap.org/search" \
  --data-urlencode "q=독도" -d format=json -d polygon_geojson=1 \
  -d "viewbox=131.85,37.255,131.88,37.23" -d bounded=1 -d limit=10
sleep 1.5
curl -fsS -m 60 -A "$UA" -o raw/seoul_osm.json -G "https://nominatim.openstreetmap.org/search" \
  --data-urlencode "q=서울특별시" -d format=json -d polygon_geojson=1 -d polygon_threshold=0.002 -d limit=1

ls -la raw
