// SID-243's command lists: scripts/test-diff-guard.mjs asserts them, scripts/test-hooks.mjs feeds them to the regression corpus.
const K = ['diff.external', 'diff.enc.textconv', 'diff.enc.command', 'DIFF.External', 'diff.ENC.TextConv', 'Diff.X.Command', 'diff.a.b.textconv', 'diff.a.b.command', "'diff.a b.textconv'", 'diff..command'];

const CONFIG_FORMS = [
  (k) => `git config ${k} /tmp/x.sh`, (k) => `git config --local ${k} /tmp/x.sh`, (k) => `git config --global ${k} /tmp/x.sh`, (k) => `git config --system ${k} /tmp/x.sh`, (k) => `git config --worktree ${k} /tmp/x.sh`,
  (k) => `git config --file .git/config ${k} /tmp/x.sh`, (k) => `git config --file=.git/config ${k} /tmp/x.sh`, (k) => `git config -f .git/config ${k} /tmp/x.sh`, (k) => `git config -f ./.git/config ${k} /tmp/x.sh`, (k) => `git config -f.git/config ${k} /tmp/x.sh`,
  (k) => `git config -f .git/worktrees/w/config.worktree ${k} /tmp/x.sh`, (k) => `git config --fil .git/config ${k} /tmp/x.sh`, (k) => `git config -zf .git/config ${k} /tmp/x.sh`,
  (k) => `git config --loc ${k} /tmp/x.sh`, (k) => `git config --add ${k} /tmp/x.sh`, (k) => `git config --ad ${k} /tmp/x.sh`, (k) => `git config --replace-all ${k} /tmp/x.sh`, (k) => `git config --replace ${k} /tmp/x.sh`,
  (k) => `git config --unset ${k}`, (k) => `git config --unset-all ${k}`, (k) => `git config --unset-a ${k}`, (k) => `git config set ${k} x`, (k) => `git config unset ${k}`, (k) => `git config set --all ${k} x`, (k) => `git config unset --all ${k}`,
  (k) => `git config --comment --get ${k} /tmp/x.sh`, (k) => `git config --comment=c ${k} /tmp/x.sh`, (k) => `git config --type=path ${k} /tmp/x.sh`, (k) => `git config --type path ${k} /tmp/x.sh`, (k) => `git config -- ${k} /tmp/x.sh`, (k) => `git config --default=d ${k} /tmp/x.sh`, (k) => `git config --blob=x ${k} y`, (k) => `echo \`git config --unset ${k}\``,
  (k) => `git -C . config ${k} /tmp/x.sh`, (k) => `git --no-pager config ${k} /tmp/x.sh`, (k) => `/usr/bin/git config ${k} /tmp/x.sh`, (k) => `env git config ${k} /tmp/x.sh`, (k) => `command git config ${k} /tmp/x.sh`, (k) => `GIT_DIR=.git git config ${k} /tmp/x.sh`,
];
const SECTION_FORMS = ['git config --rename-section evil diff.enc', 'git config --rename-section evil diff', 'git config rename-section evil diff.enc', 'git config --rename-section EVIL DIFF.enc', 'git config --remove-section diff.enc', 'git config remove-section diff', 'git config --rename-section diff.enc other', 'git config --rename-sec evil diff.enc', 'git config -- diff.external --get', 'git config -- diff.enc.textconv --list'];

const unq = (k) => k.replace(/^'|'$/g, '');
const OVERRIDE_FORMS = [
  (k) => `git -c ${k.startsWith("'") ? `'${unq(k)}=/tmp/x.sh'` : `${k}=/tmp/x.sh`} push origin feat/x`, (k) => `git -c ${k.startsWith("'") ? `'${unq(k)}=/tmp/x.sh'` : `${k}=/tmp/x.sh`} diff`, (k) => `git -c ${k} diff`,
  (k) => `git --config-env ${k.startsWith("'") ? `'${unq(k)}=VAR'` : `${k}=VAR`} push origin feat/x`, (k) => `git --config-env=${k.startsWith("'") ? `'${unq(k)}=VAR'` : `${k}=VAR`} diff`,
  (k) => `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${k} GIT_CONFIG_VALUE_0=/tmp/x.sh git push origin feat/x`, (k) => `GIT_CONFIG_COUNT=8 GIT_CONFIG_KEY_7=${k} GIT_CONFIG_VALUE_7=/tmp/x.sh git diff`, (k) => `env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${k} GIT_CONFIG_VALUE_0=x git diff`, (k) => `export GIT_CONFIG_KEY_0=${k}`,
  (k) => `GIT_CONFIG_PARAMETERS="'${unq(k)}'='/tmp/x.sh'" git diff`, (k) => `GIT_CONFIG_PARAMETERS="'${unq(k)}=/tmp/x.sh'" git push origin feat/x`,
];

const ATTR = '.git/info/attributes';
const ATTR_FORMS = [
  `echo '*.txt diff=enc' >> ${ATTR}`, `echo '*.txt diff=enc' > ${ATTR}`, `echo x >| ${ATTR}`, `echo x &> ${ATTR}`, `echo x 2> ${ATTR}`, `echo x <> ${ATTR}`, `printf '* -diff\\n' >> ${ATTR}`, `cat x > ${ATTR}`, `tee ${ATTR} < x`, `tee -a ${ATTR} < x`,
  `cp x ${ATTR}`, `cp x .git/info/`, `cp attributes .git/info`, `cp -t .git/info attributes`, `mv x ${ATTR}`, `mv attributes .git/info/`, `install x ${ATTR}`, `install -t .git/info attributes`, `ln -s /tmp/a ${ATTR}`, `ln /tmp/a ${ATTR}`, `ln -s ${ATTR} link`, `rsync x ${ATTR}`, `rsync attributes .git/info/`,
  `dd if=x of=${ATTR}`, `sort -o ${ATTR} x`, `sort --output=${ATTR} x`, `sort x -o${ATTR}`, `uniq x ${ATTR}`, `truncate -s0 ${ATTR}`, `sed -i 1d ${ATTR}`, `perl -i -pe s/a/b/ ${ATTR}`, 'cd .git && cp x info/', 'cd .git/info && cp x .', `git log -1 --output=${ATTR} --format=x`, `git diff --output ${ATTR}`,
  `python3 -c "open('${ATTR}','a').write('* -diff')"`, `node -e "fs.appendFileSync('${ATTR}','* -diff')"`, `ruby -e "File.write('${ATTR}','* -diff')"`, `awk 'BEGIN{print "x" > "${ATTR}"}'`, `curl -o ${ATTR} http://localhost/x`, "python3 -c \"open('.git/info/../info/attributes','a')\"", `vim ${ATTR}`, `ed ${ATTR}`, `patch ${ATTR} p`, `rm ${ATTR}`,
  `echo x >> ./${ATTR}`, 'echo x >> .git//info/attributes', 'echo x >> .git/./info/attributes', 'echo x >> .git/info/../info/attributes', `echo x >> /tmp/r/${ATTR}`, `echo x >> "${ATTR}"`, `echo x >> '${ATTR}'`, 'echo x >> .g"it"/info/attributes', 'echo x >> .git/info/attribute\\s', 'cd .git/info && tee attributes < x', 'cd .git && echo x >> info/attributes', 'cd .git/info; echo x >> attributes',
  'echo x >> .git/info/attr*', 'echo x >> .gi?/info/attributes', 'echo x >> .git/*/attributes', 'echo x >> .git/modules/s/info/attributes', 'echo x >> .git/worktrees/w/info/attributes', 'echo x >> .GIT/INFO/ATTRIBUTES', 'echo x >> bare.git/info/attributes',
  'echo x >> "$(git rev-parse --git-path info/attributes)"', 'echo x >> `git rev-parse --git-path info/attributes`', 'echo x >> "$(git rev-parse --git-dir)/info/attributes"', 'echo x >> $GIT_DIR/info/attributes', 'GIT_DIR=/tmp/g; echo x >> /tmp/g/info/attributes', `F=${ATTR}; echo x >> "$F"`,
];

// Each fails to be denied on b07b159 only if the row says so: the suite prints red/green per case.
export const MUST_DENY_CONFIG = [...K.flatMap((k) => CONFIG_FORMS.map((f) => f(k))), ...SECTION_FORMS];
export const MUST_DENY_OVERRIDE = K.flatMap((k) => OVERRIDE_FORMS.map((f) => f(k)));
export const MUST_DENY_ATTR = ATTR_FORMS;
// Forms only a whole-line read can see: the command that reads the quoted text is not one the guard parses.
export const MUST_DENY_OPAQUE = [
  `docker exec c sh -c 'git -c diff.external=/tmp/x.sh push origin feat/x'`, `docker exec c sh -c 'git -c DIFF.ENC.TEXTCONV=/tmp/x.sh diff'`, `docker exec c sh -c 'git --config-env=diff.external=VAR diff'`, `docker exec c sh -c 'git --config-env diff.enc.command=VAR diff'`,
  `docker exec c sh -c 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=x git diff'`, `parallel ::: 'GIT_CONFIG_KEY_0=Diff.X.Command git diff'`, `tmux new 'git -c diff.a.b.textconv=x diff'`, `perl -e 'system("git -c diff.external=x push")'`,
  `docker exec c sh -c "GIT_CONFIG_PARAMETERS='diff.external=x' git diff"`,
  // quoting the whole-line read can't see through: only the pieces, each read with its own quoting, show these
  `echo 'git -c di""ff.external=x diff' | sh`, `echo 'git --config-env=di""ff.external=V diff' | sh`, `echo "$(git -c di''ff.external=x diff)"`, `bash <<'E'\ngit -c di''ff.external=x diff\nE`, `cat <<'E' | sh\nGIT_CONFIG_KEY_0=di''ff.external git diff\nE`,
  // the first = ends a -c key, the last = ends a --config-env key
  `echo 'git -c di""ff.external=a=b diff' | sh`,
  // no word of these starts with the variable, so only the whole-line read sees it; and an expanding heredoc is no data
  `docker exec c sh -c "env GIT_CONFIG_PARAMETERS='diff.external=x' git diff"`, `cat <<EOF\n$(docker exec c sh -c 'git -c diff.external=x diff')\nEOF`,
  // git's own quoted form, which the whole-line read can't take apart
  "GIT_CONFIG_PARAMETERS=\\'diff.external\\'=\\'x\\' git diff",
  'git -c diff.external=a=b diff', "git --config-env='diff.a=b.command=V' diff", "git --config-env 'diff.a=b.textconv=V' diff",
  // wrappers, keywords and git's own options in text a shell is fed, where only the per-piece read can resolve the quoting
  `echo 'command git -c di""ff.external=x diff' | sh`, `echo 'if git -c di""ff.external=x diff; then :; fi' | sh`, `echo 'git -C . -c di""ff.external=x diff' | sh`, `echo 'git --git-dir=.git -c di""ff.external=x diff' | sh`, `echo 'env GIT_CONFIG_KEY_0=di""ff.external git diff' | sh`,
  'if git -c diff.external=x diff; then echo y; fi', '{ git -c diff.external=x diff; }', '( git -c diff.external=x diff )', '! git -c diff.external=x diff',
];

// setsid was no wrapper to normalize(): on b07b159 every guarded command behind it was allowed.
export const MUST_DENY_WRAPPER = ['setsid git push --force origin feat/x', 'setsid git reset --hard', "setsid sh -c 'git reset --hard'", "setsid sh -c 'gh pr merge 1'", 'setsid -w git push -f', 'setsid git config diff.external /tmp/x.sh', 'setsid --fork git clean -fdx', 'setsid gh pr merge 1'];

export const MUST_ALLOW = [
  // the issue's list
  'git config --get diff.external', "git config --get-regexp '^diff\\.'", 'git config get diff.external', 'git config --list', 'git config -l', 'git config diff.renames true', 'git config diff.algorithm histogram', 'git config diff.colorMoved zebra', 'git config diff.enc.binary true',
  'git -c diff.renames=false diff', 'git diff --no-ext-diff', "echo '*.txt diff=enc' >> .gitattributes", 'cat .git/info/attributes',
  // other reads of the same keys
  'git config diff.external', 'git config diff.enc.textconv', 'git config --get-all diff.external', 'git config --get diff.enc.textconv', 'git config get --all diff.external', 'git config --global --get diff.external', 'git config -f .git/config --get diff.external', 'git config --file=.git/config --get diff.enc.command', 'git config --show-origin --get diff.external', 'git config --type=path --get diff.external', 'git config --type path diff.external', 'git config --get DIFF.External', 'git config --get-regexp diff.external', 'git config --get diff.external somepattern', 'git config list', 'git config --name-only --list', 'git config --fil .git/config --get diff.external', 'git config -f diff.external user.name',
  // near misses: not a driver key, or not in scope
  'git config diff.textconv x', 'git config diff.x.external y', 'git config diff.enc.textconvx y', 'git config diff.enc.xfuncname x', 'git config diff.enc.cachetextconv true', 'git config xdiff.external y', 'git config difftool.x.cmd y', 'git config merge.x.driver y', 'git config user.name diff.external', 'git config user.name diff.enc.textconv', 'git config --unset diff.renames', 'git config --unset diff.enc.binary', 'git config unset diff.renames', 'git config set diff.renames true', 'git config --rename-section foo bar', 'git config --remove-section foo', 'git config --remove-section differ', 'git config --rename-section foo differ.x',
  'git -c diff.enc.binary=true diff', 'git -c diff.x.external=y diff', 'git -c color.ui=always diff', 'git --config-env=diff.renames=V diff', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.renames GIT_CONFIG_VALUE_0=false git diff', `GIT_CONFIG_PARAMETERS="'diff.renames'='false'" git diff`, 'git diff', 'git diff --ext-diff', 'git log -p --no-textconv', 'git log --grep=diff.external', "git log --grep='diff.enc.textconv'",
  // the text is only data
  "git commit -m 'git -c diff.external=x push is denied'", 'git commit -m "docs: GIT_CONFIG_KEY_0=diff.external is denied"', "git commit -m 'git config diff.external x'", "gh pr create --title x --body 'see -c diff.external=x and .git/info/attributes'", "echo 'git -c diff.external=x push'", 'git commit -m "$(cat <<\'EOF\'\nblock git -c diff.external=x\nEOF\n)"', 'grep -rn "diff.external" scripts', `git commit -m "see GIT_CONFIG_PARAMETERS='diff.external=x' for it"`,
  // reads and near-miss paths
  'grep x .git/info/attributes', 'head -1 .git/info/attributes', 'test -f .git/info/attributes', '[ -f .git/info/attributes ]', 'if [ -f .git/info/attributes ]; then echo y; fi', 'ls -l .git/info/attributes', 'wc -l .git/info/attributes', 'stat .git/info/attributes', 'cat < .git/info/attributes', 'cp .git/info/attributes /tmp/a', 'sort .git/info/attributes', 'dd if=.git/info/attributes of=/tmp/a', 'cat .git/info/*', 'echo .git/info/attributes', 'diff .git/info/attributes /tmp/a', 'md5sum .git/info/attributes',
  'echo x >> .git/info/attributes.bak', 'python3 -c "print(\'.git/info/attributes.bak\')"', 'echo x >> info/attributes', 'echo x >> .gitattributes', 'echo x >> docs/.gitattributes', 'echo x >> a/attributes', 'cp x attributes', 'cp attributes /tmp/', 'cp x .git/info/exclude', 'echo x >> .git/info/exclude', 'tee attributes < x',
  'setsid git status', 'setsid npm test', "setsid sh -c 'git status'",
];

// The price, measured as allowed on b07b159: each is denied because the guard can't tell it from a write, or because a rule is simplest whole. Pinned so growth is a visible test change.
export const COLLATERAL = [
  'git config -f /tmp/other.cfg diff.external x', // the guard can't tell a file from .git/config through a symlink, a cd or an expansion
  'git config -f .gitmodules diff.enc.textconv x',
  'git config --remove-section diff', 'git config --rename-section diff.enc diff.other', // also moves or drops diff.renames and the like
  'git commit -m "GIT_CONFIG_KEY_0=diff.external"', // a word that starts like the assignment reads as one
  'cp exclude .git/info/', 'cp -r x .git/info/', 'mv y .git/info', // the name landing in the dir is not provable
  'sed -n 1p .git/info/attributes', "awk '{print}' .git/info/attributes",'python3 -c "print(\'.git/info/attributes\')"', 'file=.git/info/attributes', // sed `w`, awk `>` and interpreters can write: use cat
  "echo 'git -c diff.external=x status' | tee notes.txt", 'git commit -m "docs: --config-env=diff.external=V is denied"', // text on a line the guard can't prove is data: tee writes a file, and --co could be a value git runs
];

export const quoteWord = (w, st) => { const m = Math.ceil(w.length / 2); return st(w.slice(0, m), w.slice(m)); };
export const STYLES = [(a, b) => `"${a}"${b}`, (a, b) => `${a}"${b}"`, (a, b) => `'${a}'${b}`, (a, b) => `${a}'${b}'`, (a, b) => `${a}\\${b}`, (a, b) => `${a}""${b}`, (a, b) => `${a}''${b}`, (a, b) => `$'${a}'${b}`];
const sqEsc = (x) => x.replace(/'/g, `'\\''`), dqEsc = (x) => x.replace(/([\\"$`])/g, '\\$1');
export const WRAPS = [
  (x) => x, (x) => `true; ${x}`, (x) => `${x} 2>&1`, (x) => `${x}; true`, (x) => `true && ${x}`, (x) => `false || ${x}`, (x) => `if true; then ${x}; fi`, (x) => `{ ${x}; }`, (x) => `( ${x} )`, (x) => `(${x})`, (x) => `nohup ${x}`, (x) => `timeout 5 ${x}`, (x) => `time ${x}`,
  (x) => `bash -c '${sqEsc(x)}'`, (x) => `sh -c '${sqEsc(x)}'`, (x) => `bash -c "${dqEsc(x)}"`, (x) => `bash -c -- '${sqEsc(x)}'`, (x) => `bash -lc '${sqEsc(x)}'`, (x) => `busybox sh -c '${sqEsc(x)}'`, (x) => `setsid sh -c '${sqEsc(x)}'`, (x) => `bash -c 'bash -c "${dqEsc(sqEsc(x))}"'`, (x) => `sh -c "sh -c '${sqEsc(dqEsc(x))}'"`, (x) => `eval '${sqEsc(x)}'`, (x) => `eval "${dqEsc(x)}"`,
  (x) => `echo '${sqEsc(x)}' | sh`, (x) => `printf '%s' '${sqEsc(x)}' | bash`, (x) => `bash <<'E'\n${x}\nE`, (x) => `cat <<'E' | sh\n${x}\nE`, (x) => `echo "$(${x})"`, (x) => `X=$(${x})`, (x) => `echo \`${x.replace(/[`\\]/g, '\\$&')}\``, (x) => x.replace(/ (\S+)$/, ' \\\n $1'), (x) => x.replace(/ /, ' \\\n'),
];
// Twelve forms, one per family, so the cross product stays small.
export const VARIANT_FORMS = ['git config diff.external /tmp/x.sh', 'git config --unset diff.enc.textconv', 'git config set Diff.X.Command x', 'git config -f .git/config diff.enc.command x', 'git config --rename-section evil diff.enc', 'git -c diff.external=/tmp/x.sh push origin feat/x', 'git --config-env=diff.enc.textconv=VAR diff', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=/tmp/x.sh git push origin feat/x', `GIT_CONFIG_PARAMETERS="'diff.enc.command'='x'" git diff`, "echo '*.txt diff=enc' >> .git/info/attributes", 'tee -a .git/info/attributes < x', 'cp x .git/info/attributes'];
const splitWords = (form) => form.split(' ').flatMap((w, k, ws) => (w.length < 2 || /['"\\$`<>=]/.test(w) ? [] : STYLES.map((st) => [...ws.slice(0, k), quoteWord(w, st), ...ws.slice(k + 1)].join(' '))));
export const QUOTE_VARIANTS = VARIANT_FORMS.flatMap(splitWords);
export const WRAP_VARIANTS = VARIANT_FORMS.flatMap((f) => WRAPS.map((w) => w(f)));
export const NESTED_QUOTE_VARIANTS = VARIANT_FORMS.flatMap((f) => splitWords(f).filter((_, k) => k % 8 === 0).flatMap((q) => [(x) => `bash -c '${sqEsc(x)}'`, (x) => `echo "$(${x})"`, (x) => `true; ${x}`].map((w) => w(q))));
