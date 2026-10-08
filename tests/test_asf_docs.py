"""The skill's own prose, checked the way the code is.

`SKILL.md` and the cookbooks are PRODUCT SURFACE — an agent reads them at
runtime and follows them. A link that resolves to nothing is therefore a
broken feature, not a typo, and it is invisible to every other test here:
the suite imports `templates/`, and none of it opens a markdown file.

This exists because one shipped. `SKILL.md`'s startup step told the agent to
"offer the install cookbook" through a release and a rename, and no cookbook
had ever been written — so an agent landing in a repo with no factory had
nothing to read and improvised the install, which is exactly how a repo ends
up stamped but with no `.env` and no `ASF_SKILL`.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent / "skills" / "agentic-sf"
SKILL_MD = SKILL_ROOT / "SKILL.md"
COOKBOOKS = SKILL_ROOT / "cookbooks"

# [text](target) — skipping external links and pure in-page anchors.
LINK = re.compile(r"\[[^\]]*\]\((?!https?://|#)([^)]+)\)")


def docs() -> list[Path]:
    return sorted([SKILL_MD, *COOKBOOKS.glob("*.md"), *(SKILL_ROOT / "references").glob("*.md")])


@pytest.mark.parametrize("doc", docs(), ids=lambda p: p.name)
def test_every_link_in_the_skill_s_prose_resolves(doc: Path):
    """A link to a file that is not there is a dead end for the agent reading it."""
    broken = []
    for target in LINK.findall(doc.read_text()):
        path = (doc.parent / target.split("#", 1)[0]).resolve()
        if not path.exists():
            broken.append(target)
    assert not broken, f"{doc.name} links to {broken}, which do not exist"


def test_every_cookbook_is_reachable_from_skill_md():
    """An orphan cookbook is as bad as a dangling link: written, never routed,
    and therefore never read by the agent it was written for."""
    routed = set(LINK.findall(SKILL_MD.read_text()))
    for cookbook in sorted(COOKBOOKS.glob("*.md")):
        target = f"cookbooks/{cookbook.name}"
        assert any(link.split("#", 1)[0] == target for link in routed), \
            f"{target} exists but SKILL.md never links to it"


def test_the_install_cookbook_is_what_startup_offers():
    """Step 1 of Startup is the ONLY thing an agent reads in a repo with no
    factory. It must hand over a real path, not the words 'install cookbook'."""
    text = SKILL_MD.read_text()
    startup = text.split("## Startup", 1)[1].split("##", 1)[0]
    assert "cookbooks/install.md" in startup, \
        "Startup does not name cookbooks/install.md — the one file that path needs"


def test_startup_routes_an_old_stamp_to_the_upgrade_cookbook_first():
    """An old stamp is never refused, so the agent is what carries it forward:
    Startup is the one place it reads before a request, and it must compare
    the stamp's record with the skill's and hand over the upgrade cookbook."""
    text = SKILL_MD.read_text()
    startup = text.split("## Startup", 1)[1].split("\n## ", 1)[0]
    assert "cookbooks/upgrade.md" in startup
    assert "asf/.skill-version" in startup and "templates/asf/.skill-version" in startup


def test_the_upgrade_cookbook_walks_every_step_a_pre_1_1_stamp_lacks():
    """What `--force` cannot do for an operator, because each is a key in the
    config it never rewrites or a person's approval — the issue's checklist."""
    cookbook = (COOKBOOKS / "upgrade.md").read_text()
    for step in ("install.py", "--force", "factory.yaml.new", "worktree.publish",
                 "cockpit.commands", "station-register", "observability", "mode: none",
                 "labels --create", "just doctor", "CHANGELOG.md"):
        assert step in cookbook, f"the upgrade cookbook never mentions {step}"


# The install and update command, the same in every place that gives one. Two agents, not one:
# `skills` copies when every target agent shares a directory, so `--agent claude-code` alone puts
# a real directory where the link to `.agents/skills/` was. `pi` reads `.agents/skills/` itself,
# which is what makes the CLI write there and link Claude Code to it — and naming agents keeps a
# `-y` from picking Eve alone in a repo the CLI sees Eve in (issue #172, checked with skills 1.7.1).
SKILLS_ADD = ("npx skills add schurik/agentic-software-factory --skill agentic-sf"
              " --agent claude-code pi -y")
README = SKILL_ROOT.parent.parent / "README.md"
ONE_AGENT_YES = re.compile(r"(?:-a|--agent)\s+claude-code\s+-y")


def test_the_upgrade_updates_the_skill_before_it_re_stamps():
    """`--force` from a stale skill stamps the old engine back, and between releases the
    version cannot say the copy is stale — so the copy is updated, and checked, first."""
    cookbook = (COOKBOOKS / "upgrade.md").read_text()
    assert "## Update the skill first" in cookbook
    assert cookbook.index("## Update the skill first") < cookbook.index("## Re-stamp")
    step = cookbook.split("## Update the skill first", 1)[1].split("\n## ", 1)[0]
    for mention in (SKILLS_ADD, "git -C <skill> pull", "claude plugin update",
                    "npx skills update", "Eve", "skills-lock.json", "readlink"):
        assert mention in " ".join(step.split()), f"updating the skill never mentions {mention}"


@pytest.mark.parametrize("doc", [README, COOKBOOKS / "install.md", COOKBOOKS / "upgrade.md"],
                         ids=lambda p: p.name)
def test_every_install_of_the_skill_is_the_command_that_links(doc: Path):
    text = doc.read_text()
    assert SKILLS_ADD in text, f"{doc.name} does not give the install/update command"
    assert not ONE_AGENT_YES.search(text), \
        f"{doc.name} suggests `--agent claude-code -y` alone, which copies instead of linking"
