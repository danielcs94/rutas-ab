#!/usr/bin/env python3
"""
Versiona los archivos de la app antes de publicar (ejecútalo antes de cada commit/push).

GitHub Pages deja que el navegador guarde cada archivo 10 minutos. Sin versión, el móvil
puede mezclar un index.html nuevo con un map.js viejo (o al revés) y la app se rompe.
Este script pone `?v=<versión>` en el CSS, en app.js y, mediante un import map, en todos
los módulos de js/, así cada publicación se descarga completa y coherente.

Uso (desde rutas-noviciado/):
  python3 tools/release.py
"""
import json
import pathlib
import re
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"


def main() -> None:
    version = time.strftime("%Y%m%d%H%M")
    html = INDEX.read_text(encoding="utf-8")

    html = re.sub(r'href="css/styles\.css(\?v=\w+)?"', f'href="css/styles.css?v={version}"', html)
    html = re.sub(r'src="js/app\.js(\?v=\w+)?"', f'src="js/app.js?v={version}"', html)

    modules = sorted(p.name for p in (ROOT / "js").glob("*.js"))
    importmap = {"imports": {f"./js/{m}": f"./js/{m}?v={version}" for m in modules}}
    block = ('<script type="importmap">\n'
             + json.dumps(importmap, indent=2, ensure_ascii=False)
             + '\n  </script>')
    if '<script type="importmap">' in html:
        html = re.sub(r'<script type="importmap">.*?</script>', block, html, flags=re.S)
    else:  # el import map tiene que ir antes que cualquier script de tipo módulo
        html = html.replace('<script type="module"', block + '\n  <script type="module"', 1)

    INDEX.write_text(html, encoding="utf-8")
    print(f"Versión {version}: {len(modules)} módulos versionados en index.html")


if __name__ == "__main__":
    main()
