import base64
import hashlib
import io
import json
import re
import shutil
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import requests
from flask import Flask, abort, jsonify, render_template, request, send_file
from PIL import Image

app = Flask(__name__)

BASE_DIR        = Path(__file__).parent
TIFF_DIR        = BASE_DIR / "datasets/Tobacco800_SinglePage/Tobacco800_SinglePage/SinglePageTIF"
XML_DIR         = BASE_DIR / "datasets/Tobacc800_Groundtruth_v2.0/Tobacc800_Groundtruth_v2.0/XMLGroundtruth_v2.0"
CACHE_DIR       = BASE_DIR / "static" / "cache"
AI_RESULTS_FILE = BASE_DIR / "ai_results.json"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

_ai_lock = threading.Lock()

DEFAULT_PROMPT = (
    "You are an expert in document forensics. Locate all handwritten signatures "
    "in this scanned document image.\n\n"
    "A SIGNATURE is a person's name written by hand as a personal mark — "
    "typically at the end of a letter or on a signature line.\n\n"
    "NOT a signature: printed text, stamps, logos, handwritten notes, initials alone.\n\n"
    "There may be ZERO, ONE, or MULTIPLE signatures. Find ALL, invent NONE.\n\n"
    "Reply with JSON only — no explanation, no markdown.\n"
    "All coordinate values are PERCENTAGES of the image dimensions, ranging from 0.0 to 100.0.\n"
    "Example for a signature in the lower-right area:\n"
    '{"has_signatures": true, "signatures": [{"x_pct": 55.0, "y_pct": 72.0, "w_pct": 22.0, "h_pct": 8.0}]}\n\n'
    "Your response:\n"
    '{\n'
    '  "has_signatures": true or false,\n'
    '  "signatures": [\n'
    '    {"x_pct": <0.0–100.0>, "y_pct": <0.0–100.0>, "w_pct": <0.0–100.0>, "h_pct": <0.0–100.0>}\n'
    '  ]\n'
    '}'
)


# ── PNG cache ──────────────────────────────────────────────────────────────────

def _cache_key(tif_path: Path) -> str:
    mtime = tif_path.stat().st_mtime
    return hashlib.sha1(f"{tif_path}:{mtime}".encode()).hexdigest()[:16]

def _get_or_create_png(tif_path: Path) -> Path:
    key = _cache_key(tif_path)
    cache_path = CACHE_DIR / f"{key}.png"
    if not cache_path.exists():
        img = Image.open(tif_path)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.save(cache_path, "PNG")
    return cache_path


# ── XML parser ─────────────────────────────────────────────────────────────────

def _parse_xml(xml_path: Path) -> dict:
    if not xml_path.exists():
        return {"signatures": [], "logos": [], "page_width": 0, "page_height": 0}
    try:
        root = ET.parse(xml_path).getroot()
        signatures, logos = [], []
        page_width = page_height = 0
        for elem in root.iter():
            tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if tag == "DL_PAGE":
                page_width  = int(elem.get("width",  0))
                page_height = int(elem.get("height", 0))
            elif tag == "DL_ZONE":
                gtype = elem.get("gedi_type", "")
                zone  = {k: int(elem.get(k, 0)) for k in ("col", "row", "width", "height")}
                if gtype == "DLSignature":
                    zone["author_id"]  = elem.get("AuthorID", "")
                    zone["overlapped"] = elem.get("Overlapped", "No")
                    signatures.append(zone)
                elif gtype == "DLLogo":
                    logos.append(zone)
        return {"signatures": signatures, "logos": logos,
                "page_width": page_width, "page_height": page_height}
    except Exception as e:
        return {"signatures": [], "logos": [], "page_width": 0, "page_height": 0, "error": str(e)}


# ── File index ─────────────────────────────────────────────────────────────────

_index: list | None = None

def _build_index() -> list:
    global _index
    if _index is not None:
        return _index
    result = []
    for tif in sorted(TIFF_DIR.glob("*.tif")):
        name = tif.stem
        xml  = XML_DIR / f"{name}.xml"
        sig_count = logo_count = 0
        if xml.exists():
            try:
                content    = xml.read_text(errors="ignore")
                sig_count  = content.count("DLSignature")
                logo_count = content.count("DLLogo")
            except Exception:
                pass
        result.append({"name": name, "has_signature": sig_count > 0,
                        "has_logo": logo_count > 0,
                        "sig_count": sig_count, "logo_count": logo_count})
    _index = result
    return result


# ── AI results persistence ─────────────────────────────────────────────────────

def _load_ai_results() -> dict:
    if AI_RESULTS_FILE.exists():
        try:
            return json.loads(AI_RESULTS_FILE.read_text())
        except Exception:
            pass
    return {}

def _backup_results() -> None:
    if not AI_RESULTS_FILE.exists():
        return
    backup_dir = BASE_DIR / "ai_results_history"
    backup_dir.mkdir(exist_ok=True)
    
    # 防抖：5 分钟内不重复备份
    backups = list(backup_dir.glob("ai_results_*.json"))
    if backups:
        newest = max(backups, key=lambda f: f.stat().st_mtime)
        if time.time() - newest.stat().st_mtime < 300:
            return
            
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = backup_dir / f"ai_results_{ts}.json"
    try:
        shutil.copy2(AI_RESULTS_FILE, backup_file)
    except Exception as e:
        print(f"Backup failed: {e}")

def _save_ai_results(data: dict) -> None:
    _backup_results()
    AI_RESULTS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


# ── Routes: existing ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/files")
def api_files():
    ai = _load_ai_results()
    idx = _build_index()
    for f in idx:
        f["has_ai"] = f["name"] in ai
    return jsonify(idx)

@app.route("/api/image/<name>")
def api_image(name):
    name = Path(name).stem
    tif_path = TIFF_DIR / f"{name}.tif"
    if not tif_path.exists():
        abort(404)
    try:
        return send_file(_get_or_create_png(tif_path), mimetype="image/png")
    except Exception:
        abort(500)

@app.route("/api/annotations/<name>")
def api_annotations(name):
    name = Path(name).stem
    return jsonify(_parse_xml(XML_DIR / f"{name}.xml"))


# ── Routes: AI detection ───────────────────────────────────────────────────────

@app.route("/api/results")
def api_results_all():
    """Return summary of all AI results (name → has_signatures + count)."""
    ai = _load_ai_results()
    summary = {k: {"has_signatures": v.get("has_signatures", False),
                   "count": len(v.get("signatures", [])),
                   "detected_at": v.get("detected_at", "")}
               for k, v in ai.items()}
    return jsonify(summary)

@app.route("/api/models")
def api_models():
    """Fetch available models from the LLM provider."""
    api_url = request.args.get("api_url", "").rstrip("/")
    api_key  = request.args.get("api_key", "")
    if not api_url or not api_key:
        return jsonify({"error": "缺少 api_url 或 api_key"}), 400
    try:
        resp = requests.get(
            f"{api_url}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=15,
        )
        resp.raise_for_status()
        data   = resp.json()
        models = [m["id"] for m in data.get("data", []) if isinstance(m, dict)]
        # Sort: vision-capable models first (heuristic: contains "gpt-4" or "vision" or "claude")
        models.sort(key=lambda m: (
            0 if any(k in m.lower() for k in ("gpt-4o", "vision", "claude-3", "gemini")) else 1,
            m
        ))
        return jsonify(models)
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"请求失败: {e}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/results/<name>")
def api_results_one(name):
    name = Path(name).stem
    ai   = _load_ai_results()
    if name not in ai:
        return jsonify(None)
    return jsonify(ai[name])

@app.route("/api/detect/<name>", methods=["POST"])
def api_detect(name):
    name = Path(name).stem
    tif_path = TIFF_DIR / f"{name}.tif"
    if not tif_path.exists():
        abort(404)

    body      = request.json or {}
    api_url   = body.get("api_url", "").rstrip("/")
    api_key   = body.get("api_key", "")
    model     = body.get("model", "gpt-4o")
    scale     = float(body.get("scale", 0.5))
    prompt    = body.get("prompt", DEFAULT_PROMPT)

    if not api_url or not api_key:
        return jsonify({"error": "请先在设置中填写 API 代理地址和 API Key"}), 400

    # Scale image and encode as JPEG base64
    try:
        img = Image.open(tif_path)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        new_w = max(1, int(img.width  * scale))
        new_h = max(1, int(img.height * scale))
        img = img.resize((new_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        return jsonify({"error": f"图片处理失败: {e}"}), 500

    # Call LLM
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"}},
                {"type": "text", "text": prompt},
            ],
        }],
        "max_tokens": 1024,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    max_retries = 3
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                f"{api_url}/chat/completions",
                headers=headers, json=payload, timeout=90)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", 10))
                wait = max(wait, 5)   # at least 5 s
                print(f"[LLM 429] Rate limited, waiting {wait}s (attempt {attempt+1}/{max_retries})")
                if attempt < max_retries - 1:
                    import time; time.sleep(wait)
                    continue
                # exhausted retries
                return jsonify({"error": f"API 限流（429），已等待重试 {max_retries} 次仍失败。请换个模型或稍后再试。"}), 429
            if not resp.ok:
                print(f"[LLM ERROR] {resp.status_code}: {resp.text[:500]}")
            resp.raise_for_status()
            break   # success
        except requests.exceptions.RequestException as e:
            print(f"[LLM EXCEPTION] attempt {attempt+1}: {e}")
            if attempt == max_retries - 1:
                return jsonify({"error": f"LLM API 请求失败: {e}"}), 502


    # Parse LLM response
    content = "(empty)"
    try:
        content = resp.json()["choices"][0]["message"]["content"]
        # Strip markdown code fences if present
        m = re.search(r'\{.*\}', content, re.DOTALL)
        parsed = json.loads(m.group() if m else content)
    except Exception as e:
        return jsonify({"error": f"解析 LLM 响应失败: {e}", "raw": content}), 502

    sigs = parsed.get("signatures", []) or []

    # Normalise coordinates returned by the model:
    # Case A: model returns 0–1 fractions  → multiply by 100
    # Case B: model returns pixel values   → divide by scaled image size
    all_vals = [s.get(k, 0) for s in sigs for k in ("x_pct", "y_pct", "w_pct", "h_pct")]
    if all_vals:
        max_val = max(all_vals)
        if max_val <= 1.5:
            # Case A: fractions → percentages
            for s in sigs:
                for k in ("x_pct", "y_pct", "w_pct", "h_pct"):
                    s[k] = round(s.get(k, 0) * 100, 2)
        elif max_val > 100:
            # Case B: pixel coordinates → percentages using scaled image size
            for s in sigs:
                s["x_pct"] = round(s.get("x_pct", 0) / new_w * 100, 2)
                s["y_pct"] = round(s.get("y_pct", 0) / new_h * 100, 2)
                s["w_pct"] = round(s.get("w_pct", 0) / new_w * 100, 2)
                s["h_pct"] = round(s.get("h_pct", 0) / new_h * 100, 2)
        # Clamp to valid range 0–100
        for s in sigs:
            s["x_pct"] = max(0.0, min(100.0, s.get("x_pct", 0)))
            s["y_pct"] = max(0.0, min(100.0, s.get("y_pct", 0)))
            s["w_pct"] = max(0.0, min(100.0 - s["x_pct"], s.get("w_pct", 0)))
            s["h_pct"] = max(0.0, min(100.0 - s["y_pct"], s.get("h_pct", 0)))

    result = {
        "detected_at": datetime.now(timezone.utc).isoformat(),
        "model":        model,
        "scale":        scale,
        "has_signatures": bool(parsed.get("has_signatures", False)),
        "signatures":   sigs,
    }

    with _ai_lock:
        ai = _load_ai_results()
        ai[name] = result
        _save_ai_results(ai)

    return jsonify(result)


@app.route("/api/stats")
def api_stats():
    """Compute hit-rate statistics at global or page level."""
    threshold = float(request.args.get("threshold", 50)) / 100.0
    names_param = request.args.get("names", "")
    ai_all = _load_ai_results()

    def gt_coverage(gt_box, ai_pct, pw, ph):
        """Intersection / GT-box area, all in pixel space."""
        if pw == 0 or ph == 0 or gt_box["width"] == 0 or gt_box["height"] == 0:
            return 0.0
        gx1, gy1 = gt_box["col"], gt_box["row"]
        gx2, gy2 = gx1 + gt_box["width"], gy1 + gt_box["height"]
        ax1 = ai_pct["x_pct"] / 100 * pw
        ay1 = ai_pct["y_pct"] / 100 * ph
        ax2 = ax1 + ai_pct["w_pct"] / 100 * pw
        ay2 = ay1 + ai_pct["h_pct"] / 100 * ph
        ix1, iy1 = max(gx1, ax1), max(gy1, ay1)
        ix2, iy2 = min(gx2, ax2), min(gy2, ay2)
        if ix2 <= ix1 or iy2 <= iy1:
            return 0.0
        return (ix2 - ix1) * (iy2 - iy1) / (gt_box["width"] * gt_box["height"])

    def classify(name, ai_res):
        gt = _parse_xml(XML_DIR / f"{name}.xml")
        gt_sigs, ai_sigs = gt["signatures"], ai_res.get("signatures", []) or []
        pw, ph = gt["page_width"], gt["page_height"]
        has_gt, has_ai = bool(gt_sigs), bool(ai_sigs)

        if not has_gt and not has_ai:
            return {"label": "TN", "matched": 0, "total_gt": 0, "avg_cov": None}
        if not has_gt:
            return {"label": "FP", "matched": 0, "total_gt": 0, "avg_cov": None}
        if not has_ai:
            return {"label": "FN", "matched": 0, "total_gt": len(gt_sigs), "avg_cov": None}

        # Greedy match: each AI box used at most once
        used = set()
        matched, covs = 0, []
        for g in gt_sigs:
            best_cov, best_i = 0.0, -1
            for i, a in enumerate(ai_sigs):
                if i in used:
                    continue
                c = gt_coverage(g, a, pw, ph)
                if c > best_cov:
                    best_cov, best_i = c, i
            if best_cov >= threshold and best_i >= 0:
                used.add(best_i)
                matched += 1
                covs.append(best_cov)

        avg_cov = sum(covs) / len(covs) if covs else 0.0
        if matched == len(gt_sigs):
            label = "TP"
        elif matched > 0:
            label = "partial"
        else:
            label = "偏"
        return {"label": label, "matched": matched,
                "total_gt": len(gt_sigs), "avg_cov": avg_cov}

    def aggregate(names):
        counts = {"TP": 0, "TN": 0, "FP": 0, "FN": 0, "partial": 0, "偏": 0}
        total_gt = total_matched = 0
        covs, files = [], []
        for n in names:
            if n not in ai_all:
                continue
            r = classify(n, ai_all[n])
            counts[r["label"]] += 1
            total_gt += r["total_gt"]
            total_matched += r["matched"]
            if r["avg_cov"]:
                covs.append(r["avg_cov"])
            files.append({
                "name": n, "label": r["label"],
                "matched": r["matched"], "total_gt": r["total_gt"],
                "avg_cov": round(r["avg_cov"] * 100, 1) if r["avg_cov"] else None,
                "model": ai_all[n].get("model", ""),
            })
        n_total = sum(counts.values())
        hit = counts["TP"] + counts["TN"]
        return {
            "n": n_total,
            "hit_rate": round(hit / n_total * 100, 1) if n_total else 0,
            "counts": counts,
            "box_recall": round(total_matched / total_gt * 100, 1) if total_gt else None,
            "avg_cov": round(sum(covs) / len(covs) * 100, 1) if covs else None,
            "files": files,
        }

    all_names = list(ai_all.keys())
    page_names = [n.strip() for n in names_param.split(",") if n.strip()] if names_param else []
    return jsonify({
        "threshold": round(threshold * 100, 0),
        "global": aggregate(all_names),
        "page":   aggregate(page_names) if page_names else None,
    })


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Building file index …")
    idx = _build_index()
    print(f"Ready — {len(idx)} files indexed. Visit http://127.0.0.1:5001")
    app.run(host="127.0.0.1", port=5001, debug=False)
