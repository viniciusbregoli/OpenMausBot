import subprocess,shutil,os
B=os.environ['GITHUB_WORKSPACE']+'/'
OUT=os.environ['OUT']+'/checks.txt'
def say(line):
    print(line,flush=True)
    open(OUT,'a').write(line+'\n')
def run(cmd,timeout=900):
    return subprocess.run(cmd,cwd=B,capture_output=True,text=True,timeout=timeout)
r=run(['pnpm','exec','vitest','run','src/components/PlacesRail.test.ts','src/components/PlacesRail.frame.test.ts','src/components/AccountMenu.test.ts','src/components/HomeLine.test.ts','src/components/HomeScreen.test.ts','scripts/testing/file-size-ratchet.test.ts','scripts/testing/comment-history.test.ts','electron/updater.test.mjs','electron/included-x.test.mjs','electron/included-pages.test.mjs','--testTimeout=15000'])
say('tests exit %d'%r.returncode)
for l in (r.stdout+r.stderr).split('\n'):
    if any(k in l for k in ('Test Files','Tests ','FAIL','×','AssertionError')): say('  '+l.strip()[:190])
RA='electron/rail-accounts.mjs'; CR='electron/cloud-rail.mjs'; CS='electron/cloud-accounts.mjs'; CA='electron/cloud-account.mjs'; AM='electron/accounts-main.mjs'; IX='electron/included-x.mjs'; PR='src/components/PlacesRail.tsx'; ME='src/components/AccountMenu.tsx'; AP='electron/account-places.mjs'
TR='electron/rail-accounts.node-test.mjs'; TA='electron/cloud-accounts.node-test.mjs'; TM='electron/accounts-main.node-test.mjs'; TP='src/components/PlacesRail.test.ts'; TE='src/components/AccountMenu.test.ts'; TI='electron/included-x.test.mjs'
M=[
('one account gets grouped',CR,'if (waiting.length) return withAccounts(all, { saved, waiting, email: state?.account?.email ?? null });','return withAccounts(all, { saved, waiting, email: state?.account?.email ?? null });',TR),
('saved accounts dropped from the rail',CR,'if (waiting.length) return withAccounts(all, { saved, waiting, email: state?.account?.email ?? null });','',TR),
('a shared team twice',RA,'if (taken.has(origin)) return false;','',TR),
('a shared team twice among saved',RA,'    taken.add(origin);\n','',TR),
('groups not sorted',RA,'.sort((a, b) => a.email.localeCompare(b.email))','',TR),
('hand servers in a group',RA,'.map((row) => ({ ...row, group: HAND }))','.map((row) => ({ ...row, group: ACTIVE }))',TR),
('no row for an empty account',RA,'return rows.length ? rows : [{ id: `${ACCOUNT_PLACE}${account.id}`, name: account.email, color: null, kind: "account", opens: true, ...mark }];','return rows;',TR),
('kept rows keep live state',RA,'.map(({ id, name, color, kind, ended }) => ({ id, name, color, kind, opens: true, ...(ended ? { ended: true } : {}) }))','',TR),
('hand server kept with an account',RA,'!row.forget && !row.account)','!row.account)',TR),
('another account kept with this one',RA,'!row.forget && !row.account)','!row.forget)',TR),
('no email on rows',RA,'email: account.email, ...(account.signIn','...(account.signIn',TR),
('sign-in state dropped',RA,'...(account.signIn ? { signIn: true } : {})','',TR),
('click never switches',CR,'return place.account ? switchingTo(place) : opening(place);','return opening(place);',TR),
('refused click still opens',CR,'if (said.outcome !== "switched") return { outcome: said.outcome, ...(said.email ? { email: said.email } : {}) };','',TR),
('account id reaches the page',CR,'const seen = ({ cloudId: _cloudId, account: _account, ...place }) => place;','const seen = ({ cloudId: _cloudId, ...place }) => place;',TR),
('old sign-in runs mid-switch',CA,'const current = stamp => !closed && !quiet && generation === stamp;','const current = stamp => !closed && generation === stamp;',TA),
('quiet never cleared',CA,'      quiet = false;\n','',TA),
('failed switch leaves it stopped',CS,'await client().reload().catch((error) => log(`accounts: ${error?.message ?? error}`));','',TA),
('failed switch leaves the window',CS,'await settled().catch((error) => log(`accounts: ${error?.message ?? error}`));','',TA),
('browser way says nothing',CS,'if (entry.browser) { browserResult = result; changed(); }','',TA),
('browser failure unhandled',CS,'.catch((error) => { log(`accounts: ${error?.message ?? error}`); return { outcome: "failed" }; })','',TA),
('browser result told twice',CS,'addResult() { const result = browserResult; browserResult = null; return result; }','addResult() { return browserResult; }',TA),
('sessions go before the sign-out',CS,'await client().signOut();\n      await left(id);','await left(id);\n      await client().signOut();',TM),
('places not kept',AM,'places().put(id, left, rows);','',TM),
('places not back',AM,'deps.persist(withPlacesBack(deps.saved(), places().take(id).places));','',TM),
('lending not forgotten at sign-out',AM,'for (const place of places().take(id).places) deps.forgetLending(place);','',TM),
('rows kept with live state',AM,'rows: accountRows(deps.rows())','rows: deps.rows()',TM),
('a page switches accounts',AM,'  own("accounts:add-reopen"','  own("accounts:switch", (id) => ring().switchTo(id));\n  own("accounts:add-reopen"',TM),
('stale token stays with the server',IX,'if (held && held.deviceId !== deviceId && planKey(latest) === key) { held = null; send(null); }','',TI),
('no divider',PR,'{startsGroup(shown, at) && <span role="separator" data-rail-divider className="h-px w-4 bg-hairline" />}','',TP),
('a divider always',PR,'export const startsGroup = (places: RailPlace[], at: number): boolean => at > 0 && places[at]!.group !== places[at - 1]!.group;','export const startsGroup = (places: RailPlace[], at: number): boolean => at > 0;',TP),
('tooltip without the address',PR,'[placeStatus(place, now), own, place.signIn && t("accounts.needsSignIn")]','[placeStatus(place, now), place.signIn && t("accounts.needsSignIn")]',TP),
('tooltip without sign-in',PR,'[placeStatus(place, now), own, place.signIn && t("accounts.needsSignIn")]','[placeStatus(place, now), own]',TP),
('search misses the address',PR,'${place.email ?? ""}','',TP),
('list past eight loses its groups',PR,'{startsGroup(found, at) && <div data-rail-group','{false && <div data-rail-group',TP),
('refusal says nothing',PR,'else { const note = switchNote(said); if (note) setAccounts({ adding: null, note }); }','',TP),
('expired click does nothing',PR,'if (said.outcome === "sign-in") setAccounts({ adding: said.email ?? place.email ?? "", note: null });','if (said.outcome === "sign-in") return;',TP),
('no ＋ for an account alone',PR,' || state.add.account === true','',TP),
('add choice missing','src/components/PlaceAddSheet.tsx','{account && <Choice kind="account"','{false && <Choice kind="account"',TP),
('You menu keeps Add beside a rail',ME,'...(noRail ? [{ key: "accounts-add"','...(true ? [{ key: "accounts-add"',TE),
('You menu loses Add with no rail',ME,'...(noRail ? [{ key: "accounts-add"','...(false ? [{ key: "accounts-add"',TE),
]
for n,f,o,w,tst in M:
    p=B+f
    s=open(p,newline='').read()
    if o not in s: say('NOMATCH  '+n); continue
    shutil.copy(p,p+'.mutbak'); open(p,'w',newline='').write(s.replace(o,w,1))
    try:
        cmd=['node','--test','--test-timeout=15000',tst] if tst.endswith('.node-test.mjs') else ['pnpm','exec','vitest','run',tst,'--testTimeout=8000']
        r=run(cmd,200)
        say(('CAUGHT   ' if r.returncode else 'SURVIVED ')+n)
    except subprocess.TimeoutExpired: say('TIMEOUT  '+n)
    finally: shutil.move(p+'.mutbak',p)
r=run(['pnpm','typecheck'],900)
say('typecheck exit %d'%r.returncode)
if r.returncode: say((r.stdout+r.stderr)[-1800:])
r=run(['bash','-c','node --test --test-timeout=60000 electron/*.node-test.mjs 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail|cancelled)" | cut -c1-170 | sort -u | tail -30'],1200)
say('electron suite:'); say(r.stdout)
say('CHECKSDONE')
