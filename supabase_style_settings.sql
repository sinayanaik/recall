-- Run this in Supabase SQL Editor if your existing project already has decks/cards.
--
-- This stores one Aa style document PER USER (row id = the user's auth id), plus
-- a legacy shared row id = 'global' that new accounts inherit until they sync a
-- style of their own. See the policy block below.
-- It deliberately excludes colors. Theme colors stay in CSS; Aa controls focus on layout,
-- readable px-based font sizes, spacing, radius, and percent-based widths/heights.
-- Re-running this file is safe: it fills missing defaults while preserving existing custom values.

CREATE TABLE IF NOT EXISTS app_style_settings (
  id TEXT PRIMARY KEY DEFAULT 'global',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE app_style_settings
  ALTER COLUMN settings SET DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_style_settings_object'
  ) THEN
    ALTER TABLE app_style_settings
      ADD CONSTRAINT app_style_settings_object CHECK (jsonb_typeof(settings) = 'object');
  END IF;
END $$;

ALTER TABLE app_style_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION set_app_style_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_app_style_settings_updated_at ON app_style_settings;
CREATE TRIGGER set_app_style_settings_updated_at
  BEFORE UPDATE ON app_style_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_app_style_settings_updated_at();

-- One style row PER USER, keyed on the user's auth id (the app writes
-- styleSettingsRowId(), which is auth.uid()).
--
-- This table predates auth and originally held a single row, id = 'global', with
-- wide-open "Anyone can …" policies — not even restricted TO authenticated. On a
-- deployment with more than one account that meant whoever synced last silently
-- overwrote everyone else's fonts, sizes and layout, and an anonymous visitor
-- could read or rewrite the lot. The old policies are dropped here; the legacy
-- 'global' row itself is KEPT and stays readable, so an account that has never
-- synced a style of its own still inherits whatever the deployment had.
DROP POLICY IF EXISTS "Anyone can read app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Anyone can insert app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Anyone can update app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Anyone can delete app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Signed-in users manage app style settings" ON app_style_settings;
DROP POLICY IF EXISTS "Users manage own app style settings" ON app_style_settings;

-- auth.uid() is wrapped in a scalar subquery so the planner evaluates it once
-- per statement (an InitPlan) instead of once per row. Must stay identical to
-- the policy in supabase_schema.sql, or whichever file ran last wins.
CREATE POLICY "Users manage own app style settings"
  ON app_style_settings
  FOR ALL TO authenticated
  USING (id = (select auth.uid())::text OR id = 'global')
  WITH CHECK (id = (select auth.uid())::text);

-- Shape v3. Two things changed since the flat v1 block this file used to carry:
--
--   1. Settings are per-PROFILE — { version, desktop: {…}, mobile: {…} } — so a
--      phone and a laptop can carry different sizes. The old flat object is
--      still accepted on read (normalizeStyleProfiles migrates it), but seeding
--      it here meant a fresh deployment started life on the legacy path.
--   2. Controls that wrote a CSS variable nothing read were removed, and a few
--      overlapping ones merged. Seeding those keys handed every new account
--      settings that could never do anything: sidePanelWidthPercent (no side
--      panels since the Known/Review columns went), stackCard* (no .brick
--      markup), the per-face font families (overwritten before they could
--      inherit), inputCornerRadius / actionButtonHeight / replayButtonHeight
--      (now derived from one control), questionPadding + answerPadding (now one
--      cardTextPadding).
--
-- Keep this block in sync with defaultStyleProfiles in app.js — it is the same
-- object, and the app is the source of truth.
WITH style_defaults AS (
  SELECT $style_defaults$
{
  "version": 3,
  "desktop": {
    "fontFamily": "system",
    "baseFontSize": "18px",
    "baseLineHeight": "1.58",
    "notesFontSize": "18px",
    "notesMaxWidthPercent": "100",
    "answerFontSize": "23px",
    "questionMaxFontSize": "19px",
    "appWidthPercent": "100",
    "appHeightPercent": "100",
    "cardWidthPercent": "100",
    "cardMaxHeightPercent": "84",
    "modalWidthPercent": "60",
    "visualMaxWidthPercent": "50",
    "markdownBoxHeightPercent": "30",
    "appGap": "10px",
    "panelPadding": "10px",
    "cardPadding": "24px",
    "cardContentGap": "16px",
    "buttonGap": "8px",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "buttonCornerRadius": "8px",
    "cardBorderWidth": "1px",
    "questionFillPercent": "58",
    "questionLineHeight": "1.18",
    "questionAlign": "center",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    "answerLineHeight": "1.58",
    "answerFontWeight": "400",
    "notesLineHeight": "1.58",
    "notesFontWeight": "400",
    "notesPadding": "6px",
    "cardTextPadding": "2px",
    "toolbarButtonHeight": "38px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "modalPadding": "18px",
    "rawMarkdownFontSize": "18px",
    "codeFontSize": "18px",
    "codeLineHeight": "1.55"
  },
  "mobile": {
    "fontFamily": "system",
    "baseFontSize": "12px",
    "baseLineHeight": "1.23",
    "notesFontSize": "15px",
    "notesMaxWidthPercent": "100",
    "answerFontSize": "13px",
    "questionMaxFontSize": "23px",
    "appWidthPercent": "100",
    "appHeightPercent": "100",
    "cardWidthPercent": "96",
    "cardMaxHeightPercent": "80",
    "modalWidthPercent": "60",
    "visualMaxWidthPercent": "90",
    "markdownBoxHeightPercent": "30",
    "appGap": "10px",
    "panelPadding": "10px",
    "cardPadding": "24px",
    "cardContentGap": "16px",
    "buttonGap": "8px",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "buttonCornerRadius": "8px",
    "cardBorderWidth": "1px",
    "questionFillPercent": "75",
    "questionLineHeight": "1.17",
    "questionAlign": "left",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    "answerLineHeight": "1.58",
    "answerFontWeight": "300",
    "notesLineHeight": "1.5",
    "notesFontWeight": "400",
    "notesPadding": "4px",
    "cardTextPadding": "2px",
    "toolbarButtonHeight": "34px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "modalPadding": "18px",
    "rawMarkdownFontSize": "16px",
    "codeFontSize": "12px",
    "codeLineHeight": "1.17"
  }
}
$style_defaults$::jsonb AS settings
)
INSERT INTO app_style_settings (id, settings)
SELECT 'global', settings
FROM style_defaults
ON CONFLICT (id) DO UPDATE
-- Preserve whatever the deployment already customised, one profile at a time:
-- the top-level merge below would replace the whole `desktop` object with the
-- defaults, so each profile is merged into its own defaults first. A row still
-- in the flat v1 shape has no desktop/mobile keys, so it contributes nothing
-- here and simply gets the new defaults — the app migrates the user's own row.
SET settings = jsonb_build_object(
  'version', 3,
  'desktop', (EXCLUDED.settings -> 'desktop')
    || COALESCE(app_style_settings.settings -> 'desktop', '{}'::jsonb),
  'mobile', (EXCLUDED.settings -> 'mobile')
    || COALESCE(app_style_settings.settings -> 'mobile', '{}'::jsonb)
);

COMMENT ON TABLE app_style_settings IS
  'Per-user Aa style settings (row id = auth.uid(), plus a legacy shared ''global'' row new accounts inherit) for layout, px font sizes, spacing, radius, and percent dimensions. Colors are intentionally not included.';
COMMENT ON COLUMN app_style_settings.settings IS
  'JSON object of { version, desktop: {…}, mobile: {…} }. Keys match the controls in styleControlGroups and are applied as CSS variables by app.js. The legacy flat (profile-less) shape is still read and migrated on load.';
