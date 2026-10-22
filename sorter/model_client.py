"""Neutral interface to the classification model used by sorter.py.

sorter.py only needs:
  Choice / Score / Question   question types (yes/no probability = Question)
  client.system_one(state, questions) -> result with .answers, .model, .usage
  MODEL                       model id recorded in results

The concrete provider binding lives in an adapter module (default: http_adapter,
override with env MODEL_ADAPTER). Field names on answers (.choice, .confidence, .score, .p_yes)
are normalized by the adapter so routing code stays provider-agnostic.
"""
import importlib, os

class Choice:
    def __init__(self, instructions, criteria):
        self.instructions = instructions; self.criteria = criteria; self.type = 'choice'
class Score:
    def __init__(self, instructions, criteria):
        self.instructions = instructions; self.criteria = criteria; self.type = 'score'
class Question:
    def __init__(self, instructions):
        self.instructions = instructions; self.type = 'question'

_adapter = None
def _load():
    global _adapter
    if _adapter is None:
        name = os.environ.get('MODEL_ADAPTER', 'http_adapter')
        try: _adapter = importlib.import_module(name)
        except ImportError as e:
            raise SystemExit(f"model adapter '{name}' not found ({e}). See model_client.py.")
    return _adapter

class Client:
    def system_one(self, state, questions):
        return _load().system_one(state, questions)

def client():
    return Client()

def __getattr__(name):
    if name == 'MODEL':
        return getattr(_load(), 'MODEL', os.environ.get('MODEL_NAME', 'classification-model'))
    raise AttributeError(name)
