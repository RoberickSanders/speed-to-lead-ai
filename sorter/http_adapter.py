"""Generic HTTP adapter for sorter.py.

POSTs {model, state, questions} to CLASSIFIER_API_URL with a Bearer key from
CLASSIFIER_API_KEY and normalizes the answers into objects with
.choice / .confidence / .score / .p_yes. Point it at any structured
classification endpoint, or replace this module with your provider's SDK.
"""
import json, os, urllib.request
from types import SimpleNamespace as NS

MODEL = os.environ.get("CLASSIFIER_MODEL", "your-classifier-model")

def _q(q):
    d = {"type": "yes_no" if q.type == "question" else q.type, "instructions": q.instructions}
    if getattr(q, "criteria", None) is not None:
        d["criteria"] = q.criteria
    return d

def system_one(state, questions):
    url = os.environ["CLASSIFIER_API_URL"]; key = os.environ["CLASSIFIER_API_KEY"]
    body = json.dumps({"model": MODEL, "state": state, "questions": {k: _q(v) for k, v in questions.items()}}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = json.load(r)
    answers = {k: NS(choice=a.get("choice"), confidence=a.get("confidence", 0.0), score=a.get("score"), p_yes=a.get("p_yes", 0.0))
               for k, a in raw.get("answers", {}).items()}
    u = raw.get("usage", {})
    return NS(answers=answers, model=raw.get("model", MODEL),
              usage=NS(input_tokens=u.get("input_tokens", 0), output_tokens=u.get("output_tokens", 0)))
