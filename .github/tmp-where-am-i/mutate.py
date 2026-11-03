#!/usr/bin/env python3
# Breaks each behaviour in turn and says whether a test notices. Inside the heavy-run lock, with explicit test files.
# Each file is put back byte for byte after its mutation; the script refuses to start on a dirty tree.
import os, subprocess, sys, re
ROOT = os.environ.get("MUTATE_ROOT", "/Users/milindsoni/Documents/mywork/_work/omb-where-am-i")
RAIL_NODE = ["node", "--test", "electron/chrome-rail.node-test.mjs"]
CLOUD_NODE = ["node", "--test", "electron/cloud-rail.node-test.mjs"]
vt = lambda *files: ["npx", "vitest", "run", *files]
FRAME = vt("src/components/WindowFrameBar.test.ts")
LIST = vt("src/components/WindowPlacesList.test.ts")
PLAN = vt("src/lib/cloud-plan.test.ts")
PRO = vt("src/components/ProIntroduction.test.ts")
DIALOG = vt("src/components/CloudAddDialog.test.ts")
ACCOUNT = vt("src/components/CloudAccountSettings.test.ts")
M = [
 ("the tag's click opens the list", "src/components/WindowPlaceTitle.tsx", "onClick={() => void openList().catch(() => {})}", "onClick={() => {}}", FRAME),
 ("an older app's tag is a label", "src/components/WindowPlaceTitle.tsx", "if (!openList) return <div data-window-place className={tag}>{face}</div>;", "if (!openList) return <button data-window-place className={tag}>{face}</button>;", FRAME),
 ("a server is called a server", "src/components/WindowPlaceTitle.tsx", 'return config ? "server" : null;', 'return config ? "cloud" : null;', FRAME),
 ("no kind word until the page knows", "src/components/WindowPlaceTitle.tsx", 'return config ? "server" : null;', 'return "server";', FRAME),
 ("a team by main's word", "src/components/WindowPlaceTitle.tsx", "if (place.role || config?.team) return \"team\";", "if (config?.team) return \"team\";", FRAME),
 ("a name that says its kind already", "src/lib/places.ts", "return name.toLocaleLowerCase().split(/\\s+/).includes(word.toLocaleLowerCase()) ? null : word;", "return word;", FRAME),
 ("the list asks main to open a row", "src/components/WindowPlacesList.tsx", "openPlace(place, setConnecting);", "", LIST),
 ("the place on screen only closes", "src/components/WindowPlacesList.tsx", "if (place.active) { onClose(); return; }", "", LIST),
 ("signed out: the sign-in line", "src/components/WindowPlacesList.tsx", "{state.add.signIn && <>", "{false && <>", LIST),
 ("the sign-in line signs in through main", "src/components/WindowPlacesList.tsx", 'void window.ogb?.workspaces?.add?.("signIn").catch(() => {});', "", LIST),
 ("a press outside closes", "src/components/WindowPlacesList.tsx", "if (event.target === event.currentTarget) onClose();", "", LIST),
 ("Escape closes", "src/components/WindowPlacesList.tsx", 'if (event.key === "Escape") { event.preventDefault(); onClose(); return; }', "", LIST),
 ("the arrows move through the rows", "src/components/WindowPlacesList.tsx", "rows[(at + step + rows.length) % rows.length]!.focus();", "", LIST),
 ("the list is a menu", "src/components/WindowPlacesList.tsx", 'role="menu" aria-label', 'role="dialog" aria-label', LIST),
 ("asked before the page was up", "src/components/WindowPlacesList.tsx", "if (besideRail !== null) show(besideRail);", "", LIST),
 ("shows only once covering", "src/components/WindowPlacesList.tsx", "open: wanted && covering,", "open: wanted,", LIST),
 ("sized against the window", "src/components/WindowPlacesList.tsx", "max-w-[calc(100%-32px)]", "max-w-[calc(100vw-32px)]", LIST),
 ("the keyboard lands on the place on screen", "src/components/WindowPlacesList.tsx", "(sheet.current?.querySelector<HTMLElement>(\"[aria-current='page']\") ?? sheet.current?.querySelector<HTMLElement>(\"button:not([disabled])\"))?.focus();", "sheet.current?.querySelector<HTMLElement>(\"button:not([disabled])\")?.focus();", LIST),
 ("closing lets go of the view", "src/components/WindowPlacesList.tsx", "void rail?.listClosed?.().catch(() => {});", "", LIST),
 ("the tiles stay away with no rail", "src/components/ChromeRail.tsx", 'list.hidesRail && "invisible"', "false", LIST),
 ("hold for a sheet doesn't move the page", "electron/chrome-rail.mjs", "if (standing !== beside) {\n        beside = standing;", "if (on !== beside) {\n        beside = on;", RAIL_NODE),
 ("only the page beside asks", "electron/chrome-rail.mjs", 'if (!pageBeside(event)) throw new Error("rail:open-list is only available to the page beside the window\'s rail");', "", RAIL_NODE),
 ("only the rail's page takes it", "electron/chrome-rail.mjs", "if (!rail.owns(event)) throw new Error(`${channel} is only available to the window's rail`);", "", RAIL_NODE),
 ("asked once", "electron/chrome-rail.mjs", "listAsked = false;\n        return stands();", "return stands();", RAIL_NODE),
 ("nothing comes up where there is nothing to list", "electron/chrome-rail.mjs", "if (!listable()) return;", "", RAIL_NODE),
 ("a new document under a sheet", "electron/chrome-rail.mjs", "if (expanded) { dragLifted = null; liftDragRegions(true); }", "", RAIL_NODE),
 ("drag regions lift", "electron/chrome-rail.mjs", "      liftDragRegions(expanded);\n", "", RAIL_NODE),
 ("drag regions come back", "electron/chrome-rail.mjs", "return contents.removeInsertedCSS?.(key);", "return;", RAIL_NODE),
 ("a page that didn't load lets go", "electron/chrome-rail.mjs", "if (mainFrame && code !== ABORTED && held) rail.holdOpen(false);", "", RAIL_NODE),
 ("a late view wears the skin", "electron/chrome-rail.mjs", 'if (skinBeside) contents.send("rail:skin", skinBeside);', "", RAIL_NODE),
 ("the preload keeps the skin for later", "electron/preload.cjs", "if (skinBeside) cb(skinBeside);", "", RAIL_NODE),
 ("a server's page needs a click", "electron/preload.cjs", 'openList: () => isLocalPage || navigator.userActivation?.isActive === true\n      ? ipcRenderer.invoke("rail:open-list").then(() => undefined) : Promise.reject(new Error("Choose where you are to see your places.")),', 'openList: () => ipcRenderer.invoke("rail:open-list").then(() => undefined),', RAIL_NODE),
 ("nothing of the list comes back", "electron/preload.cjs", 'ipcRenderer.invoke("rail:open-list").then(() => undefined)', 'ipcRenderer.invoke("rail:open-list")', RAIL_NODE),
 ("the list goes only to the rail's page", "electron/cloud-rail.mjs", ": { places: [], add: { cloud: false, link: false, address: false, organization: false }, ...(beside() ? { beside: true } : {}) })));", ": { places: [], list: list().map(seen), add: { cloud: false, link: false, address: false, organization: false }, ...(beside() ? { beside: true } : {}) })));", CLOUD_NODE),
 ("every place, however few", "electron/cloud-rail.mjs", "(lists(event) ? { places: places().map(seen), list: list().map(seen), add: choices() }", "(lists(event) ? { places: places().map(seen), list: places().map(seen), add: choices() }", CLOUD_NODE),
 ("a row with too few places for a rail opens", "electron/cloud-rail.mjs", "const place = list().find(entry => entry.id === plain(id) && entry.opens);", "const place = places().find(entry => entry.id === plain(id) && entry.opens);", CLOUD_NODE),
 ("the Sign in choice", "electron/cloud-rail.mjs", 'const CHOICES = Object.freeze(["cloud", "link", "address", "signIn"]);', 'const CHOICES = Object.freeze(["cloud", "link", "address"]);', CLOUD_NODE),
 ("no sign-in while one is being read", "electron/cloud-rail.mjs", '(state?.status === "signed-out" && state.message !== "restoring")', '(state?.status === "signed-out")', CLOUD_NODE),
 ("a list change is a signal", "electron/cloud-rail.mjs", "const key = JSON.stringify([places(), list(), choices(),", "const key = JSON.stringify([places(), choices(),", CLOUD_NODE),
 ("no offer unasked to a teammate", "src/lib/cloud-plan.ts", 'return view.kind === "signed-out" || (view.kind === "free" && !view.team);', 'return view.kind === "signed-out" || view.kind === "free";', PLAN),
 ("the plan line names the team", "src/lib/cloud-plan.ts", 'return view.team ? t("cloudAccount.inTeam", { team: view.team }) : t("cloudAccount.free");', 'return t("cloudAccount.free");', PLAN),
 ("signed in from the sheet: the team's Cloud", "src/lib/cloud-plan.ts", 'if (view.kind === "free" && view.team && arrived && !account?.checkout) return teamCloudView(account?.teams?.[0] ?? null);', "", PLAN),
 ("only just after signing in", "src/lib/cloud-plan.ts", 'view.team && arrived && !account?.checkout', 'view.team && !account?.checkout', PLAN),
 ("a checkout goes on", "src/lib/cloud-plan.ts", 'view.team && arrived && !account?.checkout', 'view.team && arrived', PLAN),
 ("a plan card doesn't carry a teammate to checkout", "src/components/CloudAddDialog.tsx", "&& !state.machine && !state.teams?.length;", "&& !state.machine;", DIALOG),
 ("the browser's sign-in counts as arriving", "src/components/CloudAddDialog.tsx", ' || kind === "signing-in") && !arrived', ") && !arrived", DIALOG),
 ("the row says Not signed in", "src/components/ProIntroduction.tsx", '<><span data-cloud-not-signed-in className="font-medium text-ink">{t("cloudAccount.notSignedIn")}</span> · {summary}</>', "summary", PRO),
 ("the row signs in", "src/components/ProIntroduction.tsx", '<button type="button" data-cloud-sign-in className="ui-button"\n              onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })}>', '<button type="button" data-cloud-sign-in className="ui-button"\n              onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })}>', PRO),
 ("a removed sign-in is signed out too", "src/components/ProIntroduction.tsx", 'const signedOut = plan.view.kind === "signed-out" || plan.view.kind === "removed";', 'const signedOut = plan.view.kind === "signed-out";', PRO),
 ("the card says Not signed in", "src/components/CloudAccountSettings.tsx", '<p data-cloud-not-signed-in className="text-[14px] font-medium text-ink">{t("cloudAccount.notSignedIn")}</p>', "", ACCOUNT),
]
def run(cmd):
    r = subprocess.run(["perl", "-e", "alarm shift; exec @ARGV", "240", *cmd], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return r.returncode, r.stdout
if subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, stdout=subprocess.PIPE, text=True).stdout.strip():
    sys.exit("refusing: the tree is dirty")
only = sys.argv[1:]
survived, missing = [], []
extra = [vt("src/components/ChromeRail.test.ts", "src/components/PlacesRail.test.ts", "src/components/PlacesRail.frame.test.ts", "src/components/window-drag-regions.test.ts", "src/components/AppNotices.test.ts", "src/lib/whats-new.test.ts",
  "src/locales/vocabulary.test.ts", "src/locales/everyday-words.test.ts", "src/locales/screen-words.test.ts", "src/locales/words.test.ts", "src/locales/data-keys.test.ts", "scripts/testing/file-size-ratchet.test.ts", "scripts/testing/comment-history.test.ts"),
  ["node", "--test", "electron/preload-contract.node-test.mjs"], ["node", "scripts/generate-locale.mjs", "--check"]]
baseline_failed = False
for cmd in {tuple(entry[4]) for entry in M} | {tuple(cmd) for cmd in extra}:
    code, out = run(list(cmd))
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)
    print(f"baseline {'ok  ' if code == 0 else 'FAIL'} {' '.join(cmd)[:120]}", flush=True)
    if code != 0:
        baseline_failed = True
        print("\n".join(line[:220] for line in out.splitlines() if re.search(r"FAIL|AssertionError|✖|not ok|×|Error:|expected", line))[:6000], flush=True)
if baseline_failed: sys.exit("the tests must pass before a mutation says anything")
for name, path, old, new, cmd in M:
    if only and not any(word in name for word in only): continue
    full = f"{ROOT}/{path}"
    text = open(full, encoding="utf8", newline="").read()
    if old not in text:
        missing.append(name); print(f"MISSING  {name}", flush=True); continue
    open(full, "w", encoding="utf8", newline="").write(text.replace(old, new, 1))
    try: code, out = run(cmd)
    finally: open(full, "w", encoding="utf8", newline="").write(text)
    caught = code != 0
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)
    first = next((line.strip() for line in out.splitlines() if re.match(r"\s*(FAIL|✖|×|not ok)", line)), "")
    print(f"{'caught  ' if caught else 'SURVIVED'} {name}  {first[:120]}", flush=True)
    if not caught: survived.append(name)
print(f"\n{len(survived)} survived, {len(missing)} missing"); [print("SURVIVED:", s) for s in survived]; [print("MISSING:", s) for s in missing]
tree = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, stdout=subprocess.PIPE, text=True).stdout.strip()
print("tree clean after:", tree == "")
sys.exit(1 if survived or missing or tree else 0)
