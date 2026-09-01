"""The update notice on the landing page — the one screen a person sees every time a
browser opens. It has to appear when the install is behind and stay hidden otherwise.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_home_has_an_update_check_keyed_to_the_shipped_version():
    html = (ROOT / "home.html").read_text()
    # a placeholder launch.js fills in — never a hardcoded version
    assert "__WBROWSER_VERSION__" in html
    # it asks GitHub for the latest release, and shows the notice only when newer
    assert "releases/latest" in html
    assert "wb-update" in html
    # the notice starts hidden, so a current install shows nothing
    assert re.search(r'id="wb-update"[^>]*display:none', html)


def test_launch_stamps_the_running_version_into_the_page():
    js = (ROOT / "launch.js").read_text()
    # it must rewrite the placeholder, not copy the file verbatim (which would leave
    # the check disabled)
    assert "__WBROWSER_VERSION__" in js
    assert "package.json" in js and "replace" in js


def test_a_missing_version_disables_the_check_rather_than_crying_wolf():
    # if the stamp never happened, HAVE stays "0.0.0" / the placeholder and the script
    # returns early — a wrong "update available" is worse than none.
    html = (ROOT / "home.html").read_text()
    assert '"0.0.0"' in html and 'indexOf("__") === 0' in html
