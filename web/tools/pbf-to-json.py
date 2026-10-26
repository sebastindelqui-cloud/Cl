"""Extrae de un archivo .osm.pbf (OpenStreetMap) las rutas y paradas de bus.

    python3 tools/pbf-to-json.py bus.pbf osm-routes.json osm-stops.json

Escribe el mismo formato que devuelve Overpass ("elements"), con la geometría
de cada tramo y la posición de cada parada ya puestas en los miembros de la
relación, para que lo lea tools/osm-to-network.mjs.
"""
import json
import sys

import osmium

STOP_TAGS = (("highway", "bus_stop"), ("public_transport", "platform"), ("public_transport", "stop_position"), ("amenity", "bus_station"))


class Collect(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nodes = {}
        self.stops = []
        self.ways = {}
        self.relations = []

    def node(self, n):
        if not n.location.valid():
            return
        lat, lon = round(n.location.lat, 7), round(n.location.lon, 7)
        self.nodes[n.id] = (lat, lon)
        tags = {t.k: t.v for t in n.tags}
        if any(tags.get(k) == v for k, v in STOP_TAGS):
            self.stops.append({"type": "node", "id": n.id, "lat": lat, "lon": lon, "tags": tags})

    def way(self, w):
        geom = []
        for nd in w.nodes:
            if nd.location.valid():
                geom.append({"lat": round(nd.location.lat, 7), "lon": round(nd.location.lon, 7)})
        self.ways[w.id] = geom

    def relation(self, r):
        tags = {t.k: t.v for t in r.tags}
        if tags.get("type") != "route" or tags.get("route") != "bus":
            return
        members = [{"type": {"n": "node", "w": "way", "r": "relation"}[m.type], "ref": m.ref, "role": m.role} for m in r.members]
        self.relations.append({"type": "relation", "id": r.id, "tags": tags, "members": members})


def main(pbf, routes_out, stops_out):
    h = Collect()
    h.apply_file(pbf, locations=True)
    for rel in h.relations:
        for m in rel["members"]:
            if m["type"] == "way" and m["ref"] in h.ways:
                m["geometry"] = h.ways[m["ref"]]
            elif m["type"] == "node" and m["ref"] in h.nodes:
                m["lat"], m["lon"] = h.nodes[m["ref"]]
    with open(routes_out, "w", encoding="utf-8") as f:
        json.dump({"elements": h.relations}, f, ensure_ascii=False)
    with open(stops_out, "w", encoding="utf-8") as f:
        json.dump({"elements": h.stops}, f, ensure_ascii=False)
    print(f"{len(h.relations)} rutas de bus, {len(h.stops)} paradas, {len(h.ways)} tramos")


if __name__ == "__main__":
    main(*sys.argv[1:4])
