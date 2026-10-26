"""Descarga todas las capas de un servicio de mapas ArcGIS (por ejemplo el de
rutas de autobús de ARESEP) como GeoJSON en coordenadas GPS (WGS84).

    python3 tools/arcgis-dump.py https://mapas.aresep.go.cr/server/rest/services/I_Transporte_Externo_PII/I_Transporte_Externo_PII/MapServer out/aresep

Deja un archivo capa-<id>.geojson por capa y resumen.json con los campos.
"""
import gzip
import json
import os
import sys
import time
import urllib.parse
import urllib.request

UA = {"User-Agent": "RutaCR/1.0 (datos abiertos)"}


def get(url, params=None, tries=4):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"  reintento {k + 1}: {e}", flush=True)
            time.sleep(5 * (k + 1))
    raise RuntimeError(f"no se pudo leer {url}")


def main(service, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    info = get(service, {"f": "json"})
    layers = info.get("layers", []) + info.get("tables", [])
    summary = {"service": service, "description": info.get("description") or info.get("serviceDescription"), "layers": []}
    for lyr in layers:
        lid = lyr["id"]
        meta = get(f"{service}/{lid}", {"f": "json"})
        count = get(f"{service}/{lid}/query", {"where": "1=1", "returnCountOnly": "true", "f": "json"}).get("count")
        page = min(int(meta.get("maxRecordCount") or 1000), 2000)
        print(f"capa {lid} {meta.get('name')!r}: {count} elementos ({meta.get('geometryType')})", flush=True)
        feats = []
        offset = 0
        while count and offset < count:
            res = get(f"{service}/{lid}/query", {
                "where": "1=1", "outFields": "*", "outSR": "4326", "f": "geojson",
                "resultOffset": offset, "resultRecordCount": page, "orderByFields": meta.get("objectIdField") or "OBJECTID",
            })
            got = res.get("features", [])
            if not got:
                break
            feats.extend(got)
            offset += len(got)
        with gzip.open(os.path.join(out_dir, f"capa-{lid}.geojson.gz"), "wt", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False)
        summary["layers"].append({
            "id": lid, "name": meta.get("name"), "geometryType": meta.get("geometryType"), "count": count, "downloaded": len(feats),
            "fields": [{"name": x["name"], "alias": x.get("alias"), "type": x.get("type")} for x in meta.get("fields") or []],
            "sample": feats[0]["properties"] if feats else None,
        })
    with open(os.path.join(out_dir, "resumen.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1].rstrip("/"), sys.argv[2])
