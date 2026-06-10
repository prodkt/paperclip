import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createPipelineCaseBlockerSchema,
  createPipelineCaseIssueLinkSchema,
  createPipelineGuidanceDocumentSchema,
  openConversationPayloadSchema,
  createPipelineSchema,
  createPipelineStageSchema,
  bulkReviewCasesSchema,
  listCompanyCaseEventsQuerySchema,
  listPipelineCasesQuerySchema,
  pipelineCaseBatchIngestSchema,
  pipelineCaseIngestSchema,
  pipelineListQuerySchema,
  resolveCaseSuggestionSchema,
  reviewCaseSchema,
  reviewCasesQuerySchema,
  setPipelineTransitionsSchema,
  transitionCaseSchema,
  updatePipelineCaseSchema,
  updatePipelineSchema,
  updatePipelineStageSchema,
} from "@paperclipai/shared";
import { extractPipelineIntakeFormFields, isStageNewEntryDisabled } from "../services/pipelines.js";
import { validate } from "../middleware/validate.js";
import { pipelineService, issueService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function pipelineRoutes(db: Db) {
  const router = Router();
  const svc = pipelineService(db);

  async function assertPipelineAccess(pipelineId: string, req: Parameters<typeof assertCompanyAccess>[0]) {
    const pipeline = await svc.getPipeline(pipelineId);
    if (!pipeline) {
      return { pipeline: null as null };
    }
    assertCompanyAccess(req, pipeline.companyId);
    return { pipeline };
  }

  async function assertCaseAccess(caseId: string, req: Parameters<typeof assertCompanyAccess>[0]) {
    const pipelineCase = await svc.getPipelineCase(caseId);
    if (!pipelineCase) {
      return { pipelineCase: null as null };
    }
    const pipelineResult = await assertPipelineAccess(pipelineCase.pipelineId, req);
    if (!pipelineResult.pipeline) {
      return { pipelineCase: null as null };
    }
    return { pipelineCase, pipeline: pipelineResult.pipeline };
  }

  router.get("/companies/:companyId/pipelines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = pipelineListQuerySchema.parse(req.query);
    const pipelines = await svc.listPipelines(companyId, query);
    res.json(pipelines);
  });

  router.get("/companies/:companyId/case-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listCompanyCaseEventsQuerySchema.parse(req.query);
    const events = await svc.listCompanyCaseEvents(companyId, query);
    res.json(events);
  });

  router.get("/pipelines/:pipelineId", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const pipeline = await svc.getPipelineWithRelations(pipelineId);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    assertCompanyAccess(req, pipeline.companyId);
    res.json(pipeline);
  });

  router.post("/companies/:companyId/pipelines", validate(createPipelineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const pipeline = await svc.createPipeline(companyId, req.body);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline.created",
      entityType: "pipeline",
      entityId: pipeline.id,
      details: req.body,
    });

    res.status(201).json(pipeline);
  });

  router.patch("/pipelines/:pipelineId", validate(updatePipelineSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const existing = await svc.getPipeline(pipelineId);
    if (!existing) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const pipeline = await svc.updatePipeline(pipelineId, req.body);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline.updated",
      entityType: "pipeline",
      entityId: pipeline.id,
      details: req.body,
    });

    res.json(pipeline);
  });

  router.delete("/pipelines/:pipelineId", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const existing = await svc.getPipeline(pipelineId);
    if (!existing) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const pipeline = await svc.removePipeline(pipelineId);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline.deleted",
      entityType: "pipeline",
      entityId: pipeline.id,
    });

    res.json(pipeline);
  });

  router.get("/pipelines/:pipelineId/stages", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    const stages = await svc.listPipelineStages(pipelineId);
    res.json(stages);
  });

  router.post("/pipelines/:pipelineId/stages", validate(createPipelineStageSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const stage = await svc.createPipelineStage(pipelineId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: access.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_stage.created",
      entityType: "pipeline_stage",
      entityId: stage.id,
      details: { pipelineId, input: req.body },
    });

    res.status(201).json(stage);
  });

  router.patch("/pipelines/:pipelineId/stages/:stageId", validate(updatePipelineStageSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const stageId = req.params.stageId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const stage = await svc.updatePipelineStage(pipelineId, stageId, req.body);
    if (!stage) {
      res.status(404).json({ error: "Pipeline stage not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: access.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_stage.updated",
      entityType: "pipeline_stage",
      entityId: stage.id,
      details: { pipelineId, stageId, input: req.body },
    });

    res.json(stage);
  });

  router.delete("/pipelines/:pipelineId/stages/:stageId", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const stageId = req.params.stageId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const stage = await svc.removePipelineStage(pipelineId, stageId);
    if (!stage) {
      res.status(404).json({ error: "Pipeline stage not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: access.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_stage.deleted",
      entityType: "pipeline_stage",
      entityId: stage.id,
      details: { pipelineId, stageId },
    });

    res.json(stage);
  });

  router.get("/pipelines/:pipelineId/transitions", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    const transitions = await svc.listPipelineTransitions(pipelineId);
    res.json(transitions);
  });

  router.put("/pipelines/:pipelineId/transitions", validate(setPipelineTransitionsSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    const transitions = await svc.setPipelineTransitions(pipelineId, req.body);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: access.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline.transitions_updated",
      entityType: "pipeline",
      entityId: pipelineId,
      details: req.body,
    });

    res.json({ transitions });
  });

  router.get("/pipelines/:pipelineId/guidance-documents", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    const docs = await svc.listGuidanceDocuments(pipelineId);
    res.json(docs);
  });

  router.get("/pipelines/:pipelineId/guidance-documents/:key", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const key = req.params.key as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const doc = await svc.getGuidanceDocument(pipelineId, key);
    if (!doc) {
      res.status(404).json({ error: "Guidance document not found" });
      return;
    }

    res.json(doc);
  });

  router.put(
    "/pipelines/:pipelineId/guidance-documents/:key",
    validate(createPipelineGuidanceDocumentSchema),
    async (req, res) => {
      const pipelineId = req.params.pipelineId as string;
      const key = req.params.key as string;
      const access = await assertPipelineAccess(pipelineId, req);
      if (!access.pipeline) {
        res.status(404).json({ error: "Pipeline not found" });
        return;
      }
      const doc = await svc.upsertGuidanceDocument(pipelineId, key, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: access.pipeline.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "pipeline_guidance_document.upserted",
        entityType: "pipeline_guidance_document",
        entityId: doc.id,
        details: { pipelineId, key, ...req.body },
      });

      res.json(doc);
    },
  );

  router.delete("/pipelines/:pipelineId/guidance-documents/:key", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const key = req.params.key as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const doc = await svc.deleteGuidanceDocument(pipelineId, key);
    if (!doc) {
      res.status(404).json({ error: "Guidance document not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: access.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_guidance_document.deleted",
      entityType: "pipeline_guidance_document",
      entityId: doc.id,
      details: { pipelineId, key },
    });

    res.json(doc);
  });

  router.get("/pipelines/:pipelineId/cases", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const query = listPipelineCasesQuerySchema.parse(req.query);
    const cases = await svc.listPipelineCases(pipelineId, query);
    res.json(cases);
  });

  router.post("/pipelines/:pipelineId/cases/ingest", validate(pipelineCaseIngestSchema), async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }

    const actor = getActorInfo(req);
    const created = await svc.ingestPipelineCase(pipelineId, req.body, {
      actorId: actor.actorId,
      actorType: actor.actorType,
    });

    await logActivity(db, {
      companyId: access.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case.ingested",
      entityType: "pipeline_case",
      entityId: created.id,
      details: req.body,
    });

    res.status(201).json(created);
  });

  router.post(
    "/pipelines/:pipelineId/cases/batch",
    validate(pipelineCaseBatchIngestSchema),
    async (req, res) => {
      const pipelineId = req.params.pipelineId as string;
      const access = await assertPipelineAccess(pipelineId, req);
      if (!access.pipeline) {
        res.status(404).json({ error: "Pipeline not found" });
        return;
      }

      const actor = getActorInfo(req);
      const cases = await svc.ingestPipelineCases(pipelineId, req.body.items, {
        actorId: actor.actorId,
        actorType: actor.actorType,
      });

      await logActivity(db, {
        companyId: access.pipeline.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "pipeline_case.batch_ingested",
        entityType: "pipeline",
        entityId: pipelineId,
        details: { caseIds: cases.map((item) => item.id), count: cases.length },
      });

      res.status(201).json({ cases });
    },
  );

  router.get("/cases/:caseId", async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    res.json(caseAccess.pipelineCase);
  });

  router.patch("/cases/:caseId", validate(updatePipelineCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const updated = await svc.updatePipelineCase(caseId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case.updated",
      entityType: "pipeline_case",
      entityId: caseId,
      details: req.body,
    });

    res.json(updated);
  });

  router.post("/cases/:caseId/transition", validate(transitionCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const actor = getActorInfo(req);
    const updated = await svc.transitionCaseStage(caseId, req.body.toStageId, {
      actorId: actor.actorId,
      actorType: actor.actorType,
      reason: req.body.reason,
    });
    if (!updated) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case.transitioned",
      entityType: "pipeline_case",
      entityId: caseId,
      details: req.body,
    });

    res.json(updated);
  });

  router.post("/cases/:caseId/suggest-transition", validate(transitionCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const updated = await svc.suggestTransition(caseId, req.body.toStageId, req.body.reason);
    if (!updated) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case.transition_suggested",
      entityType: "pipeline_case",
      entityId: caseId,
      details: req.body,
    });

    res.json(updated);
  });

  router.post("/cases/:caseId/resolve-suggestion", validate(resolveCaseSuggestionSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const updated = await svc.resolveSuggestion(caseId, req.body.decision, req.body.note);
    if (!updated) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case.suggestion_resolved",
      entityType: "pipeline_case",
      entityId: caseId,
      details: req.body,
    });

    res.json(updated);
  });

  router.post("/cases/:caseId/review", validate(reviewCaseSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const updated = await svc.reviewCase(caseId, req.body.decision, req.body.note);
    if (!updated) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case.reviewed",
      entityType: "pipeline_case",
      entityId: caseId,
      details: req.body,
    });

    res.json(updated);
  });

  router.get("/companies/:companyId/review-cases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = reviewCasesQuerySchema.parse(req.query);
    const rows = await svc.listReviewCases(companyId, query);
    res.json(rows);
  });

  router.post("/companies/:companyId/review-cases/bulk", validate(bulkReviewCasesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rows = await svc.bulkReviewCases(companyId, req.body.caseIds, req.body.decision, req.body.note);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case.reviewed_bulk",
      entityType: "pipeline_case",
      entityId: companyId,
      details: {
        count: rows.length,
        decision: req.body.decision,
      },
    });

    res.json({ cases: rows });
  });

  router.get("/cases/:caseId/blockers", async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const blockers = await svc.listCaseBlockers(caseId);
    res.json(blockers);
  });

  router.post("/cases/:caseId/blockers", validate(createPipelineCaseBlockerSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const blocker = await svc.createCaseBlocker(caseId, req.body.blockedByCaseId, req.body.reason);
    if (!blocker) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case_blocker.created",
      entityType: "pipeline_case_blocker",
      entityId: blocker.id,
      details: req.body,
    });

    res.status(201).json(blocker);
  });

  router.post("/cases/:caseId/blockers/:blockerId/resolve", async (req, res) => {
    const caseId = req.params.caseId as string;
    const blockerId = req.params.blockerId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const blocker = await svc.resolveCaseBlocker(caseId, blockerId);
    if (!blocker) {
      res.status(404).json({ error: "Blocker not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case_blocker.resolved",
      entityType: "pipeline_case_blocker",
      entityId: blocker.id,
    });

    res.json(blocker);
  });

  router.get("/cases/:caseId/issue-links", async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    const links = await svc.listCaseIssueLinks(caseId);
    res.json(links);
  });

  router.post("/cases/:caseId/issue-links", validate(createPipelineCaseIssueLinkSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const link = await svc.linkCaseIssue(caseId, req.body.issueId, req.body.role);
    if (!link) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case_issue_link.created",
      entityType: "pipeline_case_issue_link",
      entityId: link.id,
      details: req.body,
    });

    res.status(201).json(link);
  });

  router.delete("/cases/:caseId/issue-links/:linkId", async (req, res) => {
    const caseId = req.params.caseId as string;
    const linkId = req.params.linkId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const link = await svc.unlinkCaseIssue(linkId, caseId);
    if (!link) {
      res.status(404).json({ error: "Issue link not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "pipeline_case_issue_link.deleted",
      entityType: "pipeline_case_issue_link",
      entityId: link.id,
      details: { caseId, linkId },
    });

    res.json(link);
  });

  router.get("/pipelines/:pipelineId/events", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    const events = await svc.listPipelineEvents(pipelineId);
    res.json(events);
  });

  router.get("/cases/:caseId/events", async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const events = await svc.listCaseEvents(caseId);
    res.json(events);
  });

  router.get("/cases/:caseId/children", async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }

    const children = await svc.listCaseChildren(caseId);
    res.json(children);
  });

  router.get("/pipelines/:pipelineId/intake-form", async (req, res) => {
    const pipelineId = req.params.pipelineId as string;
    const access = await assertPipelineAccess(pipelineId, req);
    if (!access.pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    const pipeline = await svc.getPipelineWithRelations(pipelineId);
    const firstStage = pipeline?.stages?.[0] ?? null;
    const fields = firstStage ? extractPipelineIntakeFormFields([firstStage]) : [];
    const disabledConfig = firstStage?.config?.disable;
    res.json({
      pipelineId,
      stageId: firstStage?.id ?? null,
      stageName: firstStage?.name ?? null,
      newEntriesDisabled: firstStage ? isStageNewEntryDisabled(firstStage.config) : false,
      disabledReason: disabledConfig?.reason ?? null,
      fields,
    });
  });

  router.get("/companies/:companyId/pipelines-attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.listPipelinesAttention(companyId);
    res.json(rows);
  });

  // Optional compatibility for pipeline issue conversion.
  router.post("/cases/:caseId/open-conversation", validate(openConversationPayloadSchema), async (req, res) => {
    const caseId = req.params.caseId as string;
    const caseAccess = await assertCaseAccess(caseId, req);
    if (!caseAccess.pipelineCase || !caseAccess.pipeline) {
      res.status(404).json({ error: "Case not found" });
      return;
    }
    const payload = req.body;
    const issuePayload = {
      title: payload.title ?? caseAccess.pipelineCase.title,
      description: payload.description ?? null,
      status: payload.status,
      projectId: payload.projectId ?? null,
      assigneeAgentId: payload.assigneeAgentId ?? null,
      assigneeUserId: payload.assigneeUserId ?? null,
    };
    const issue = await issueService(db).create(caseAccess.pipeline.companyId, {
      ...issuePayload,
    });

    const link = await svc.linkCaseIssue(caseId, issue.id, payload.role);

    const actorInfo = getActorInfo(req);
    await logActivity(db, {
      companyId: caseAccess.pipeline.companyId,
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      agentId: actorInfo.agentId,
      action: "pipeline_case.open_conversation",
      entityType: "issue",
      entityId: issue.id,
      details: { caseId },
    });

    res.status(201).json({
      ...link,
      issueId: issue.id,
      caseId,
    });
  });

  return router;
}
