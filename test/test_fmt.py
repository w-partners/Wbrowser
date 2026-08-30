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


def test_body_text_is_shown_with_its_size():
    # 🔴 The regression: `read` printed nothing at all for the body, so a page whose
    #    whole point was its prose looked like it had none. Worse than a cut — a cut
    #    at least shows you the first half.
    body = "\n".join(f"paragraph {i}" for i in range(60))
    out = run({"done": ["read"], "page": {"url": "https://e.com", "text": body}})
    assert f"of {len(body)} chars" in out        # the real size, not the shown size
    assert "paragraph 0" in out                  # and you can see where it starts
    assert "…" in out                            # and that there is more


def test_short_body_text_is_shown_whole_without_an_ellipsis():
    out = run({"done": ["read"], "page": {"url": "https://e.com", "text": "all of it."}})
    assert "all of it." in out
    assert "…" not in out


def test_the_header_alone_says_whether_you_are_seeing_all_of_it():
    # 🔴 `links(50)` never has to answer this — a list is always a sample. Body text
    #    is sometimes whole, so if both cases printed `text(N chars):` the shortened
    #    one would give no sign it was shortened. That is the defect this section
    #    exists to fix, so the header must carry it, not just the ellipsis below.
    whole = run({"done": ["read"], "page": {"url": "u", "text": "short."}})
    part = run({"done": ["read"], "page": {"url": "u", "text": "x\n" * 400}})
    assert "chars, all)" in whole and " of " not in whole.split("text(")[1][:20]
    assert " of " in part.split("text(")[1][:20]


def test_no_body_text_prints_no_text_line():
    out = run({"done": ["read"], "page": {"url": "https://e.com"}})
    assert "text(" not in out
