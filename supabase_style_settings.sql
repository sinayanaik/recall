-- Run this in Supabase SQL Editor if your existing project already has decks/cards.
--
-- This stores one global Aa style document.
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'app_style_settings'
      AND policyname = 'Anyone can read app style settings'
  ) THEN
    CREATE POLICY "Anyone can read app style settings"
      ON app_style_settings FOR SELECT
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'app_style_settings'
      AND policyname = 'Anyone can insert app style settings'
  ) THEN
    CREATE POLICY "Anyone can insert app style settings"
      ON app_style_settings FOR INSERT
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'app_style_settings'
      AND policyname = 'Anyone can update app style settings'
  ) THEN
    CREATE POLICY "Anyone can update app style settings"
      ON app_style_settings FOR UPDATE
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'app_style_settings'
      AND policyname = 'Anyone can delete app style settings'
  ) THEN
    CREATE POLICY "Anyone can delete app style settings"
      ON app_style_settings FOR DELETE
      USING (true);
  END IF;
END $$;

WITH style_defaults AS (
  SELECT $style_defaults$
{
  "fontFamily": "system",
  "questionFontFamily": "system",
  "answerFontFamily": "system",
  "appWidthPercent": "98",
  "appHeightPercent": "100",
  "sidePanelWidthPercent": "16",
  "cardWidthPercent": "96",
  "cardMaxHeightPercent": "74",
  "modalWidthPercent": "60",
  "markdownBoxHeightPercent": "30",
  "baseFontSize": "18px",
  "baseLineHeight": "1.58",
  "codeFontSize": "15px",
  "codeLineHeight": "1.55",
  "questionFillPercent": "58",
  "questionLineHeight": "1.18",
  "questionAlign": "center",
  "questionVerticalAlign": "center",
  "questionFontWeight": "500",
  "questionPadding": "2px",
  "answerFontSize": "23px",
  "answerLineHeight": "1.58",
  "answerFontWeight": "400",
  "answerPadding": "0px",
  "appGap": "10px",
  "panelPadding": "10px",
  "cardPadding": "24px",
  "cardContentGap": "16px",
  "buttonGap": "8px",
  "stackCardGap": "7px",
  "cardBorderWidth": "1px",
  "cardCornerRadius": "14px",
  "panelCornerRadius": "14px",
  "buttonCornerRadius": "8px",
  "inputCornerRadius": "8px",
  "toolbarButtonHeight": "38px",
  "actionButtonHeight": "42px",
  "buttonFontSize": "14px",
  "replayButtonHeight": "30px",
  "stackCardFontSize": "13px",
  "stackCardLineHeight": "1.28",
  "inputHeight": "40px",
  "modalPadding": "18px"
}
$style_defaults$::jsonb AS settings
)
INSERT INTO app_style_settings (id, settings)
SELECT 'global', settings
FROM style_defaults
ON CONFLICT (id) DO UPDATE
SET settings = EXCLUDED.settings || COALESCE((
  SELECT jsonb_object_agg(key, value)
  FROM jsonb_each(app_style_settings.settings)
  WHERE key = ANY (ARRAY[
    'fontFamily',
    'questionFontFamily',
    'answerFontFamily',
    'appWidthPercent',
    'appHeightPercent',
    'sidePanelWidthPercent',
    'cardWidthPercent',
    'cardMaxHeightPercent',
    'modalWidthPercent',
    'markdownBoxHeightPercent',
    'baseFontSize',
    'baseLineHeight',
    'codeFontSize',
    'codeLineHeight',
    'questionFillPercent',
    'questionLineHeight',
    'questionAlign',
    'questionVerticalAlign',
    'questionFontWeight',
    'questionPadding',
    'answerFontSize',
    'answerLineHeight',
    'answerFontWeight',
    'answerPadding',
    'appGap',
    'panelPadding',
    'cardPadding',
    'cardContentGap',
    'buttonGap',
    'stackCardGap',
    'cardBorderWidth',
    'cardCornerRadius',
    'panelCornerRadius',
    'buttonCornerRadius',
    'inputCornerRadius',
    'toolbarButtonHeight',
    'actionButtonHeight',
    'buttonFontSize',
    'replayButtonHeight',
    'stackCardFontSize',
    'stackCardLineHeight',
    'inputHeight',
    'modalPadding'
  ])
), '{}'::jsonb);

COMMENT ON TABLE app_style_settings IS
  'One-row global Aa style settings for layout, px font sizes, spacing, radius, and percent dimensions. Colors are intentionally not included.';
COMMENT ON COLUMN app_style_settings.settings IS
  'Flat JSON object. Keys match Aa controls and are applied as CSS variables by app.js.';
