CREATE TABLE plugin_missions_8c47c0d099.missions (
  mission_issue_id uuid PRIMARY KEY REFERENCES public.issues(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  billing_code text,
  root_origin_kind text,
  root_origin_id text,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plugin_missions_missions_company_id_idx
  ON plugin_missions_8c47c0d099.missions (company_id);

CREATE TABLE plugin_missions_8c47c0d099.mission_findings (
  mission_issue_id uuid NOT NULL REFERENCES plugin_missions_8c47c0d099.missions(mission_issue_id) ON DELETE CASCADE,
  finding_key text NOT NULL,
  validation_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  fix_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  title text NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_issue_id, finding_key)
);

CREATE TABLE plugin_missions_8c47c0d099.mission_events (
  mission_issue_id uuid NOT NULL REFERENCES plugin_missions_8c47c0d099.missions(mission_issue_id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_issue_id, event_key)
);

CREATE INDEX plugin_missions_mission_events_company_id_idx
  ON plugin_missions_8c47c0d099.mission_events (company_id);
