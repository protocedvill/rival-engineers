"""Fetch blueprints from factorioprints.com with attribution (SPEC §5.4 "Online").

factorioprints keeps its data in a public Firebase Realtime Database with an open REST API (no key):
  https://facorio-blueprints.firebaseio.com/blueprintSummaries.json   (title, favourites, image)
  https://facorio-blueprints.firebaseio.com/blueprints/<key>.json     (blueprintString, author, tags, ...)
  https://facorio-blueprints.firebaseio.com/users/<uid>/displayName.json
  https://facorio-blueprints.firebaseio.com/byTag/<tag path>.json     (keys per tag)
(The "facorio" typo is the real host name.) The site states no licence, so every module keeps the
author name and URL; see docs/reports/proto-module-sourcing.md.

Downloaded records are untrusted data. Write them to their own directory and read them with python3 -I.

Usage:
  python3 -I tools/modules/factorioprints.py search WORD [WORD...] [--top 300]
  python3 -I tools/modules/factorioprints.py fetch -o DIR -- KEY [KEY...]   (keys start with "-")
      writes DIR/<key>.json (the record) and appends DIR/ATTRIBUTION.jsonl
"""
import argparse
import json
import os
import urllib.parse
import urllib.request

DB = "https://facorio-blueprints.firebaseio.com"


def get(path, **params):
    q = "?" + urllib.parse.urlencode(params) if params else ""
    with urllib.request.urlopen(DB + path + q, timeout=60) as r:
        return json.load(r)


def search(words, top):
    summaries = get("/blueprintSummaries.json", orderBy='"numberOfFavorites"', limitToLast=top)
    hits = []
    for key, s in summaries.items():
        title = s.get("title", "")
        if all(w.lower() in title.lower() for w in words):
            hits.append((s.get("numberOfFavorites", 0), key, title))
    for fav, key, title in sorted(hits, reverse=True):
        print(f"{key}  fav={fav:<5} {title}")


def fetch(keys, out):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "ATTRIBUTION.jsonl"), "a") as attr:
        for key in keys:
            rec = get(f"/blueprints/{key}.json")
            rec.pop("favorites", None)  # list of other users' ids; not needed
            uid = (rec.get("author") or {}).get("userId")
            name = get(f"/users/{uid}/displayName.json") if uid else None
            with open(os.path.join(out, f"{key}.json"), "w") as f:
                json.dump(rec, f)
            entry = {"key": key, "title": rec.get("title"), "author": name, "author_id": uid,
                     "url": f"https://factorioprints.com/view/{key}", "licence": "none stated",
                     "tags": rec.get("tags")}
            attr.write(json.dumps(entry) + "\n")
            print(f"{key}: {rec.get('title')!r} by {name}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("search"); p.add_argument("words", nargs="+"); p.add_argument("--top", type=int, default=300)
    p = sub.add_parser("fetch"); p.add_argument("keys", nargs="+"); p.add_argument("-o", required=True)
    a = ap.parse_args()
    if a.cmd == "search":
        search(a.words, a.top)
    else:
        fetch(a.keys, a.o)


if __name__ == "__main__":
    main()
