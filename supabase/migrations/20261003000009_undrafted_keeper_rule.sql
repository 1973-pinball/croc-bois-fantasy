-- Apply the established undrafted cost/tenure rule to the 36 reviewed setups.
-- Preserve matching commissioner confirmations and every original source field.
-- Empty projects use the ordered post-seed reconciliation helper after bootstrap.
create or replace function private.apply_undrafted_keeper_rule_20261003() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  target_league constant uuid := '4bda6ccb-0b37-47b2-8d9e-fe452603738d';
  target_season constant uuid := '60f1e9ec-31d9-42b5-8103-d75fa7ae2b00';
  target_rule constant uuid := '9271f0d6-b58b-4141-8144-ee088fa875aa';
  migration_id constant text := '20261003000009_undrafted_keeper_rule';
  corrections constant jsonb := $undrafted_rule$[
  {
    "player": "John Collins",
    "playerId": 3908845,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Ayo Dosunmu",
    "playerId": 4397002,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Donovan Clingan",
    "playerId": 5105565,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Reed Sheppard",
    "playerId": 4711272,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Ace Bailey",
    "playerId": 4873138,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Bennedict Mathurin",
    "playerId": 4683634,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Tre Jones",
    "playerId": 4395626,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Nic Claxton",
    "playerId": 4278067,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Saddiq Bey",
    "playerId": 4397136,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Josh Hart",
    "playerId": 3062679,
    "expected": {
      "base_round": 12,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Provisional round 12. Commissioner will double-check the 2024 free-agent history."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 12,
      "reviewFlags": [
        "provisional_commissioner_base_2025_round_13_pending_history_check",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A97",
        "'2025 Draft'!E97",
        "commissioner-marked-2025-draft:row-97",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "inferenceRequiresReview": false
    },
    "desiredExplanation": "Undrafted in 2024 and retained in 2025: the established league rule counts the initial active season as tenure one, giving tenure two after retention. The nominal cost progresses from round 13 to round 12 for the 2026 keeper decision. Actual payment rounds remain separate; cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2024,
      "sourceCells": [
        "'2025 Draft'!A97",
        "'2025 Draft'!E97",
        "commissioner-marked-2025-draft:row-97",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "originalReviewFlags": [
        "provisional_commissioner_base_2025_round_13_pending_history_check",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Deni Avdija",
    "playerId": 4683021,
    "expected": {
      "base_round": 12,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 13,
      "reviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A98",
        "'2025 Draft'!E98",
        "commissioner-marked-2025-draft:row-98",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2024 and retained in 2025: the established league rule counts the initial active season as tenure one, giving tenure two after retention. The nominal cost progresses from round 13 to round 12 for the 2026 keeper decision. Actual payment rounds remain separate; cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2024,
      "sourceCells": [
        "'2025 Draft'!A98",
        "'2025 Draft'!E98",
        "commissioner-marked-2025-draft:row-98",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "originalReviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Aaron Gordon",
    "playerId": 3064290,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Santi Aldama",
    "playerId": 4593125,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Keyonte George",
    "playerId": 4433627,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Andrew Wiggins",
    "playerId": 3059319,
    "expected": {
      "base_round": 12,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 13,
      "reviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A102",
        "'2025 Draft'!E102",
        "commissioner-marked-2025-draft:row-102",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2024 and retained in 2025: the established league rule counts the initial active season as tenure one, giving tenure two after retention. The nominal cost progresses from round 13 to round 12 for the 2026 keeper decision. Actual payment rounds remain separate; cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2024,
      "sourceCells": [
        "'2025 Draft'!A102",
        "'2025 Draft'!E102",
        "commissioner-marked-2025-draft:row-102",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "originalReviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Jabari Smith Jr.",
    "playerId": 4432639,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Collin Gillespie",
    "playerId": 4278585,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Cason Wallace",
    "playerId": 4683692,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Jonathan Kuminga",
    "playerId": 4433247,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Payton Pritchard",
    "playerId": 4066354,
    "expected": {
      "base_round": 12,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 13,
      "reviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A99",
        "'2025 Draft'!E99",
        "commissioner-marked-2025-draft:row-99",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2024 and retained in 2025: the established league rule counts the initial active season as tenure one, giving tenure two after retention. The nominal cost progresses from round 13 to round 12 for the 2026 keeper decision. Actual payment rounds remain separate; cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2024,
      "sourceCells": [
        "'2025 Draft'!A99",
        "'2025 Draft'!E99",
        "commissioner-marked-2025-draft:row-99",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "originalReviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Ryan Rollins",
    "playerId": 4591725,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Neemias Queta",
    "playerId": 4397424,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Precious Achiuwa",
    "playerId": 4431679,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Quentin Grimes",
    "playerId": 4397014,
    "expected": {
      "base_round": 12,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Provisional round 12. Commissioner will double-check the 2024 free-agent history."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 11,
      "reviewFlags": [
        "provisional_commissioner_base_2025_round_13_pending_history_check",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A87",
        "'2025 Draft'!E87",
        "commissioner-marked-2025-draft:row-87",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "inferenceRequiresReview": false
    },
    "desiredExplanation": "Undrafted in 2024 and retained in 2025: the established league rule counts the initial active season as tenure one, giving tenure two after retention. The nominal cost progresses from round 13 to round 12 for the 2026 keeper decision. Actual payment rounds remain separate; cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2024,
      "sourceCells": [
        "'2025 Draft'!A87",
        "'2025 Draft'!E87",
        "commissioner-marked-2025-draft:row-87",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "originalReviewFlags": [
        "provisional_commissioner_base_2025_round_13_pending_history_check",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Naji Marshall",
    "playerId": 4278594,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Dyson Daniels",
    "playerId": 4869342,
    "expected": {
      "base_round": 12,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 13,
      "reviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A103",
        "'2025 Draft'!E103",
        "commissioner-marked-2025-draft:row-103",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2024 and retained in 2025: the established league rule counts the initial active season as tenure one, giving tenure two after retention. The nominal cost progresses from round 13 to round 12 for the 2026 keeper decision. Actual payment rounds remain separate; cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2024,
      "sourceCells": [
        "'2025 Draft'!A103",
        "'2025 Draft'!E103",
        "commissioner-marked-2025-draft:row-103",
        "'2024 Draft'!A2:E105 (absent from complete draft)",
        "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"
      ],
      "originalReviewFlags": [
        "base_2025_derived_from_round_13_payment_and_maximum_round",
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "VJ Edgecombe",
    "playerId": 5124612,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Herbert Jones",
    "playerId": 4277813,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Jrue Holiday",
    "playerId": 3995,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Dejounte Murray",
    "playerId": 3907497,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Paul George",
    "playerId": 4251,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Derik Queen",
    "playerId": 4869780,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Dylan Harper",
    "playerId": 5037871,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Norman Powell",
    "playerId": 2595516,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Kon Knueppel",
    "playerId": 5061575,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  },
  {
    "player": "Nickeil Alexander-Walker",
    "playerId": 4278039,
    "expected": {
      "base_round": 13,
      "tenure_years": 1,
      "verification": "provisional",
      "explanation": "Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."
    },
    "originalSource": {
      "wasKept": false,
      "payment2025": null,
      "reviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "inferenceRequiresReview": true
    },
    "desiredExplanation": "Undrafted in 2025: the established league rule counts the initial active season as tenure one and sets the initial keeper cost at round 13. Cost and tenure are confirmed without numerical changes.",
    "evidence": {
      "rule": "The initial active undrafted season counts as tenure one; initial nominal cost is round 13 and decreases by one after retention, independently of actual payment.",
      "authorization": "Commissioner confirmed this established rule and authorized confirmation of every matching setup on 2026-10-03.",
      "initialUndraftedSeason": 2025,
      "sourceCells": [
        "'2025 Draft'!A2:E105 (absent from complete draft)"
      ],
      "originalReviewFlags": [
        "undrafted_first_season_tenure_one_is_an_explicit_inference"
      ],
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      }
    }
  }
]$undrafted_rule$::jsonb;
  s public.seasons; item jsonb; previous public.keeper_profiles; updated public.keeper_profiles;
  desired_source jsonb; applied integer:=0; already_applied integer:=0; already_confirmed integer:=0;
begin
  if not exists(select 1 from public.leagues where id=target_league) then
    return jsonb_build_object('status','awaiting-bootstrap','applied',0,'alreadyApplied',0,'alreadyConfirmed',0);
  end if;
  perform 1 from public.leagues where id=target_league and espn_league_id=139935 for update;
  if not found then raise exception 'Undrafted keeper rule league identity conflicts; no profiles changed'; end if;
  select * into s from public.seasons where id=target_season for update;
  if not found or s.league_id<>target_league or s.draft_year<>2026 or s.rule_version_id<>target_rule then
    raise exception 'Undrafted keeper rule season/rule identity conflicts; no profiles changed';
  end if;
  for item in select value from jsonb_array_elements(corrections) loop
    select * into previous from public.keeper_profiles where season_id=target_season and player_id=(item->>'playerId')::bigint for update;
    if not found then raise exception 'Undrafted keeper rule missing profile for %; no profiles changed',item->>'player'; end if;
    desired_source:=(item->'originalSource')||jsonb_build_object('undraftedRuleApplication20261003',item->'evidence');
    if previous.league_id<>target_league or previous.rule_version_id<>target_rule
      or previous.base_round is distinct from (item->'expected'->>'base_round')::integer
      or previous.tenure_years is distinct from (item->'expected'->>'tenure_years')::integer then
      raise exception 'Undrafted keeper rule numeric or identity conflict for %; no profiles changed',item->>'player';
    end if;
    -- Replayed evidence must have its attributable audit event. A later commissioner
    -- explanation is retained verbatim rather than restored to the migration text.
    if previous.verification='confirmed' and previous.source_metadata=desired_source then
      if not exists(select 1 from public.audit_events where league_id=target_league and entity_id=target_season and event_type='keeper_profile_undrafted_rule_applied'
        and detail->>'migration'=migration_id and detail->>'player_id'=item->>'playerId'
        and detail->'updated'->'source_metadata'=desired_source and detail->'updated'->>'verification'='confirmed'
        and (detail->'updated'->>'base_round')::integer=previous.base_round and (detail->'updated'->>'tenure_years')::integer=previous.tenure_years) then
        raise exception 'Undrafted keeper rule audit missing for %; review manually',item->>'player';
      end if;
      already_applied:=already_applied+1;
      continue;
    end if;
    if previous.source_metadata is distinct from item->'originalSource' then
      raise exception 'Undrafted keeper rule source conflict for %; no profiles changed',item->>'player';
    end if;
    -- Matching real commissioner confirmations are complete decisions. Do not
    -- change their reason, metadata, status, or create a misleading new audit event.
    if previous.verification='confirmed' then
      already_confirmed:=already_confirmed+1;
      continue;
    end if;
    if previous.verification is distinct from 'provisional' or previous.explanation is distinct from item->'expected'->>'explanation' then
      raise exception 'Undrafted keeper rule review conflict for %; no profiles changed',item->>'player';
    end if;
    if s.keepers_revealed_at is not null or s.phase not in ('setup','keeper_selection') then raise exception 'Undrafted keeper rule cannot change frozen profiles'; end if;
    if not exists(select 1 from public.player_ownerships o join public.roster_snapshots rs on rs.id=o.source_snapshot_id and rs.season_id=o.season_id
      where o.season_id=target_season and o.player_id=previous.player_id and rs.frozen_at is not null) then
      raise exception 'Undrafted keeper rule player is outside the frozen pool';
    end if;
    if exists(select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id
      where a.season_id=target_season and a.player_id=previous.player_id and k.is_current and k.status in ('approved','locked')) then
      raise exception 'Reject the approved keeper submission before applying the undrafted rule';
    end if;
    update public.keeper_profiles set verification='confirmed',explanation=item->>'desiredExplanation',source_metadata=desired_source
      where season_id=target_season and player_id=previous.player_id returning * into updated;
    insert into public.audit_events(league_id,event_type,entity_id,detail)
      values(target_league,'keeper_profile_undrafted_rule_applied',target_season,jsonb_build_object(
        'migration',migration_id,'player_id',previous.player_id,'actor',jsonb_build_object('kind','established-rule-application','database_role',session_user),
        'previous',to_jsonb(previous),'updated',to_jsonb(updated),'evidence',item->'evidence'));
    applied:=applied+1;
  end loop;
  return jsonb_build_object('status','applied','applied',applied,'alreadyApplied',already_applied,'alreadyConfirmed',already_confirmed);
end $$;

-- Maintenance only: clients and the service-role API cannot run this helper.
revoke all on function private.apply_undrafted_keeper_rule_20261003() from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then
  revoke all on function private.apply_undrafted_keeper_rule_20261003() from service_role;
end if; end $$;
select private.apply_undrafted_keeper_rule_20261003();
