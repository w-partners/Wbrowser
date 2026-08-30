"""fmt.py — what reaches the screen.

The engine already sends the whole answer; this file is the last place it can be
lost. The tests below are about that one job: does the value you asked for arrive
intact, and when something *is* shortened, does the screen say so.
"""
import json
import subprocess
import sys
from pathlib import Path

FMT = Path(__file__).resolve().parent.parent / "fmt.py"


def run(payload):
    p = subprocess.run(
        [sys.executable, str(FMT)],
        input=json.dumps(payload), capture_output=True, text=True,
    )
    assert p.returncode == 0, p.stderr
    return p.stdout


def result_line(out):
    for line in out.splitlines():
        if line.startswith("  result:"):
            return line[len("  result: "):]
    raise AssertionError(f"no result line in:\n{out}")


def test_long_string_is_not_cut():
    # 🔴 This is the regression. `eval` used to stop at 1200 characters and print
    #    nothing to say it had, so a query returning more looked like it had
    #    returned exactly that much.
    body = "X" * 5000
    assert result_line(run({"done": ["eval"], "result": body})) == body


def test_object_is_not_cut():
    obj = {"items": list(range(500))}
    assert json.loads(result_line(run({"done": ["eval"], "result": obj}))) == obj


def test_short_values_are_unchanged():
    for v in ("hello", 42, True, None, ""):
        got = result_line(run({"done": ["eval"], "result": v}))
        assert got == (v if isinstance(v, str) else json.dumps(v))


def test_multiline_string_keeps_its_lines():
    body = "\n".join(f"line {i}" for i in range(200))
    assert result_line(run({"done": ["eval"], "result": body})) == "line 0"
    assert "line 199" in run({"done": ["eval"], "result": body})


def test_page_summary_still_shortens_its_lists():
    # The opposite of the above, and the reason the cut was there to begin with:
    # the summary is a glance, so it caps its lists on purpose.
    out = run({"done": ["read"], "page": {
        "url": "https://example.com",
        "links": [{"text": f"l{i}", "href": f"https://example.com/{i}"} for i in range(50)],
    }})
    assert "links(50)" in out                      # the real count is still reported
    assert out.count("    - l") == 8               # but only a few are listed
