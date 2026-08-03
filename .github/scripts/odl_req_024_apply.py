from pathlib import Path

exec(Path(".github/scripts/odl_req_024_finalize.py").read_text(), {"__name__": "__main__"})
