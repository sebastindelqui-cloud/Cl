"""Descarga capas de servicios de mapas ArcGIS (por ejemplo los de transporte
de ARESEP) como GeoJSON en coordenadas GPS (WGS84).

    python3 tools/arcgis-dump.py <url de MapServer o de carpeta> <carpeta de salida> [filtro]

Con la URL de una carpeta (…/rest/services/I_Transporte_Externo) revisa todos
sus servicios. Solo descarga las capas cuyo nombre coincide con el filtro
(expresión regular). Deja <servicio>-<id>.geojson.gz por capa y resumen.json.
"""
import gzip
import json
import os
import re
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


def esri_to_geojson(f):
    g = f.get("geometry") or {}
    if "paths" in g:
        geom = {"type": "MultiLineString", "coordinates": g["paths"]}
    elif "x" in g:
        geom = {"type": "Point", "coordinates": [g["x"], g["y"]]}
    elif "rings" in g:
        geom = {"type": "Polygon", "coordinates": g["rings"]}
    else:
        geom = None
    return {"type": "Feature", "properties": f.get("attributes", {}), "geometry": geom}


def dump_layer(service, lid, out_dir, tag):
    meta = get(f"{service}/{lid}", {"f": "json"})
    oid = meta.get("objectIdField") or next((x["name"] for x in meta.get("fields") or [] if x.get("type") == "esriFieldTypeOID"), "OBJECTID")
    ids = get(f"{service}/{lid}/query", {"where": "1=1", "returnIdsOnly": "true", "f": "json"}).get("objectIds") or []
    ids.sort()
    lines = meta.get("geometryType") == "esriGeometryPolyline"
    print(f"{tag} capa {lid} {meta.get('name')!r}: {len(ids)} elementos ({meta.get('geometryType')})", flush=True)
    feats = []
    step = 50 if lines else 500
    for k in range(0, len(ids), step):
        chunk = ids[k:k + step]
        params = {"objectIds": ",".join(map(str, chunk)), "outFields": "*", "outSR": "4326", "f": "json"}
        if lines:
            params["maxAllowableOffset"] = "0.00005"  # ~5 m: trazado más liviano
        res = get(f"{service}/{lid}/query", params)
        feats.extend(esri_to_geojson(f) for f in res.get("features", []))
    with gzip.open(os.path.join(out_dir, f"{tag}-{lid}.geojson.gz"), "wt", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False)
    return {
        "service": tag, "id": lid, "name": meta.get("name"), "geometryType": meta.get("geometryType"), "count": len(ids), "downloaded": len(feats),
        "oid": oid, "fields": [{"name": x["name"], "alias": x.get("alias"), "type": x.get("type")} for x in meta.get("fields") or []],
        "sample": feats[0]["properties"] if feats else None,
    }


def services_in(url):
    if re.search(r"/(MapServer|FeatureServer)$", url):
        return [url]
    info = get(url, {"f": "json"})
    base = url.split("/rest/services")[0] + "/rest/services/"
    return [base + s["name"] + "/" + s["type"] for s in info.get("services", []) if s["type"] == "MapServer"]


def main(url, out_dir, pattern=".*"):
    os.makedirs(out_dir, exist_ok=True)
    rx = re.compile(pattern, re.I)
    summary = {"source": url, "layers": [], "all": []}
    for service in services_in(url):
        tag = service.rstrip("/").split("/")[-2]
        try:
            info = get(service, {"f": "json"})
        except RuntimeError as e:
            print(e)
            continue
        for lyr in info.get("layers", []):
            summary["all"].append({"service": tag, "id": lyr["id"], "name": lyr["name"]})
            if lyr.get("subLayerIds") or not rx.search(lyr["name"]):
                continue
            try:
                summary["layers"].append(dump_layer(service, lyr["id"], out_dir, tag))
            except RuntimeError as e:
                print(e)
    with open(os.path.join(out_dir, "resumen.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1].rstrip("/"), sys.argv[2], *(sys.argv[3:4]))
