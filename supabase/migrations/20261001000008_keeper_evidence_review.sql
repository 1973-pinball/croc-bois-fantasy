-- Confirm eleven proven 2024 fresh-draft / 2025 retained keeper histories.
-- No cost or tenure changes. The 36 undrafted profiles remain provisional.
-- Original bootstrap metadata is preserved exactly and evidence is appended.
-- Run after seed on fresh installations using apply-keeper-evidence-review.sql.
create or replace function private.apply_keeper_evidence_review_20261001() returns jsonb
language plpgsql set search_path='' as $$
declare
  target_league constant uuid := '4bda6ccb-0b37-47b2-8d9e-fe452603738d';
  target_season constant uuid := '60f1e9ec-31d9-42b5-8103-d75fa7ae2b00';
  target_rule constant uuid := '9271f0d6-b58b-4141-8144-ee088fa875aa';
  migration_id constant text := '20261001000008_keeper_evidence_review';
  corrections constant jsonb := $keeper_evidence$[
  {
    "player": "Cade Cunningham",
    "playerId": 4432166,
    "expected": {
      "base_round": 2,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 2,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-4 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-2 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 3,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A22",
        "'2025 Draft'!E22",
        "commissioner-marked-2025-draft:row-22",
        "'2025 Draft'!R30",
        "'2024 Draft'!A28",
        "'2024 Draft'!E28"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 4,
        "playerCell": "'2024 Draft'!E28",
        "roundCell": "'2024 Draft'!A28"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 22,
        "paymentRound": 3,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Jaylen Brown",
    "playerId": 3917376,
    "expected": {
      "base_round": 4,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 4,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-6 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-4 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 5,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A38",
        "'2025 Draft'!E38",
        "commissioner-marked-2025-draft:row-38",
        "'2025 Draft'!R45",
        "'2024 Draft'!A44",
        "'2024 Draft'!E44"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 6,
        "playerCell": "'2024 Draft'!E44",
        "roundCell": "'2024 Draft'!A44"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 38,
        "paymentRound": 5,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "OG Anunoby",
    "playerId": 3934719,
    "expected": {
      "base_round": 6,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 6,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-8 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-6 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 7,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A57",
        "'2025 Draft'!E57",
        "commissioner-marked-2025-draft:row-57",
        "'2025 Draft'!R64",
        "'2024 Draft'!A63",
        "'2024 Draft'!E63"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 8,
        "playerCell": "'2024 Draft'!E63",
        "roundCell": "'2024 Draft'!A63"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 57,
        "paymentRound": 7,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Jalen Suggs",
    "playerId": 4432165,
    "expected": {
      "base_round": 7,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 7,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-9 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-7 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 7,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A53",
        "'2025 Draft'!E53",
        "commissioner-marked-2025-draft:row-53",
        "'2025 Draft'!R70",
        "'2024 Draft'!A69",
        "'2024 Draft'!E69"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 9,
        "playerCell": "'2024 Draft'!E69",
        "roundCell": "'2024 Draft'!A69"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 53,
        "paymentRound": 7,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Zach Edey",
    "playerId": 4600663,
    "expected": {
      "base_round": 11,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 11,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-13 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-11 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 12,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A94",
        "'2025 Draft'!E94",
        "commissioner-marked-2025-draft:row-94",
        "'2025 Draft'!R107",
        "'2024 Draft'!A101",
        "'2024 Draft'!E101"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 13,
        "playerCell": "'2024 Draft'!E101",
        "roundCell": "'2024 Draft'!A101"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 94,
        "paymentRound": 12,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Pascal Siakam",
    "playerId": 3149673,
    "expected": {
      "base_round": 4,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 4,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-6 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-4 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 5,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A37",
        "'2025 Draft'!E37",
        "commissioner-marked-2025-draft:row-37",
        "'2025 Draft'!R49",
        "'2024 Draft'!A48",
        "'2024 Draft'!E48"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 6,
        "playerCell": "'2024 Draft'!E48",
        "roundCell": "'2024 Draft'!A48"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 37,
        "paymentRound": 5,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Austin Reaves",
    "playerId": 4066457,
    "expected": {
      "base_round": 10,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 10,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-12 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-10 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 11,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A89",
        "'2025 Draft'!E89",
        "commissioner-marked-2025-draft:row-89",
        "'2025 Draft'!R96",
        "'2024 Draft'!A90",
        "'2024 Draft'!E90"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 12,
        "playerCell": "'2024 Draft'!E90",
        "roundCell": "'2024 Draft'!A90"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 89,
        "paymentRound": 11,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Jalen Green",
    "playerId": 4437244,
    "expected": {
      "base_round": 10,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 10,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-12 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-10 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 11,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A83",
        "'2025 Draft'!E83",
        "commissioner-marked-2025-draft:row-83",
        "'2025 Draft'!R100",
        "'2024 Draft'!A95",
        "'2024 Draft'!E95"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 12,
        "playerCell": "'2024 Draft'!E95",
        "roundCell": "'2024 Draft'!A95"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 83,
        "paymentRound": 11,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Amen Thompson",
    "playerId": 4684740,
    "expected": {
      "base_round": 11,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 11,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-13 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-11 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 12,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A96",
        "'2025 Draft'!E96",
        "commissioner-marked-2025-draft:row-96",
        "'2025 Draft'!R108",
        "'2024 Draft'!A102",
        "'2024 Draft'!E102"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 13,
        "playerCell": "'2024 Draft'!E102",
        "roundCell": "'2024 Draft'!A102"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 96,
        "paymentRound": 12,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Josh Giddey",
    "playerId": 4871145,
    "expected": {
      "base_round": 4,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 4,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-6 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-4 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 5,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A40",
        "'2025 Draft'!E40",
        "commissioner-marked-2025-draft:row-40",
        "'2025 Draft'!R76",
        "'2024 Draft'!A49",
        "'2024 Draft'!E49"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 6,
        "playerCell": "'2024 Draft'!E49",
        "roundCell": "'2024 Draft'!A49"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 40,
        "paymentRound": 5,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  },
  {
    "player": "Paolo Banchero",
    "playerId": 4432573,
    "expected": {
      "base_round": 5,
      "tenure_years": 2,
      "verification": "provisional",
      "explanation": "Tenure inferred from first retention in the supplied 2024/2025 keeper lists."
    },
    "desired": {
      "base_round": 5,
      "tenure_years": 2,
      "verification": "confirmed",
      "explanation": "Historical tenure verified: fresh 2024 round-7 draft (tenure one), absent from the 2024 keeper list, then marked as kept in 2025 (tenure two). The 2026 nominal round-5 cost is unchanged; original blank tenure and source evidence are retained."
    },
    "originalSource": {
      "wasKept": true,
      "payment2025": 6,
      "reviewFlags": [
        "tenure_inferred_from_complete_2024_draft_and_keeper_list"
      ],
      "sourceCells": [
        "'2025 Draft'!A43",
        "'2025 Draft'!E43",
        "commissioner-marked-2025-draft:row-43",
        "'2025 Draft'!R51",
        "'2024 Draft'!A50",
        "'2024 Draft'!E50"
      ],
      "inferenceRequiresReview": true
    },
    "evidence": {
      "reviewId": "20261001000008_keeper_evidence_review",
      "method": "fresh-draft-plus-marked-retention",
      "sources": {
        "workbookSha256": "b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da",
        "extractedWorkbookSha256": "8bafe97e19f75ee01ae087abed58259220eee9e96fa9968733b7bcc3a71ac1dc",
        "commissionerMarkedDraftSha256": "83a4b24a567b0e0e88ffb8c4c0874e718533fc13e7f506743e1cefdd88ac52c8",
        "keeperCostSourceSha256": "3cfde875f4cc63f2d5a364f98b955ee5de17c9a81811e7f3ddd41f3870859058"
      },
      "fresh2024Draft": {
        "round": 7,
        "playerCell": "'2024 Draft'!E50",
        "roundCell": "'2024 Draft'!A50"
      },
      "absentFrom2024Keepers": "'2025 Draft'!Y4:Y37 (34 confirmed keepers)",
      "retained2025": {
        "marker": "x",
        "row": 43,
        "paymentRound": 6,
        "source": "commissioner-marked-2025-draft"
      },
      "rule": "The drafted season counts as tenure one; retaining for 2025 adds one. The blank source tenure remains preserved."
    }
  }
]$keeper_evidence$::jsonb;
  s public.seasons; item jsonb; previous public.keeper_profiles; updated public.keeper_profiles;
  desired_source jsonb; applied integer:=0; already_applied integer:=0;
begin
  -- Empty projects receive schema migrations before the one-time bootstrap.
  if not exists(select 1 from public.leagues where id=target_league) then
    return jsonb_build_object('status','awaiting-bootstrap','applied',0,'alreadyApplied',0);
  end if;
  perform 1 from public.leagues where id=target_league and espn_league_id=139935 for update;
  if not found then raise exception 'Keeper evidence review league identity conflicts; no profiles changed'; end if;
  select * into s from public.seasons where id=target_season for update;
  if not found or s.league_id<>target_league or s.draft_year<>2026 or s.rule_version_id<>target_rule then
    raise exception 'Keeper evidence review season/rule identity conflicts; no profiles changed';
  end if;
  for item in select value from jsonb_array_elements(corrections) loop
    select * into previous from public.keeper_profiles where season_id=target_season and player_id=(item->>'playerId')::bigint for update;
    if not found then raise exception 'Keeper evidence review missing profile for %; no profiles changed',item->>'player'; end if;
    desired_source:=(item->'originalSource')||jsonb_build_object('evidenceReview20261001',item->'evidence');
    if previous.league_id<>target_league or previous.rule_version_id<>target_rule then
      raise exception 'Keeper evidence review identity changed for %; no profiles changed',item->>'player';
    end if;
    -- An exact already-applied state plus its audit entry makes reruns harmless.
    if previous.base_round=(item->'desired'->>'base_round')::integer and previous.tenure_years=(item->'desired'->>'tenure_years')::integer
      and previous.verification='confirmed' and previous.explanation=item->'desired'->>'explanation' and previous.source_metadata=desired_source then
      if not exists(select 1 from public.audit_events where league_id=target_league and entity_id=target_season and event_type='keeper_profile_evidence_confirmed'
        and detail->>'migration'=migration_id and detail->>'player_id'=item->>'playerId' and detail->'updated'=to_jsonb(previous)) then
        raise exception 'Keeper evidence review audit missing for %; review manually',item->>'player';
      end if;
      already_applied:=already_applied+1;
      continue;
    end if;
    if previous.base_round is distinct from (item->'expected'->>'base_round')::integer
      or previous.tenure_years is distinct from (item->'expected'->>'tenure_years')::integer
      or previous.verification is distinct from 'provisional'
      or previous.explanation is distinct from item->'expected'->>'explanation'
      or previous.source_metadata is distinct from item->'originalSource' then
      raise exception 'Keeper evidence review conflict for %: existing commissioner values or source evidence changed; no profiles changed',item->>'player';
    end if;
    if s.keepers_revealed_at is not null or s.phase not in ('setup','keeper_selection') then raise exception 'Keeper evidence review cannot change frozen profiles'; end if;
    if not exists(select 1 from public.player_ownerships where season_id=target_season and player_id=previous.player_id) then raise exception 'Keeper evidence review player is outside the frozen pool'; end if;
    if exists(select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id
      where a.season_id=target_season and a.player_id=previous.player_id and k.is_current and k.status in ('approved','locked')) then
      raise exception 'Reject the approved keeper submission before applying evidence review';
    end if;
    update public.keeper_profiles set verification='confirmed',explanation=item->'desired'->>'explanation',source_metadata=desired_source
      where season_id=target_season and player_id=previous.player_id returning * into updated;
    insert into public.audit_events(league_id,event_type,entity_id,detail)
      values(target_league,'keeper_profile_evidence_confirmed',target_season,jsonb_build_object(
        'migration',migration_id,'player_id',previous.player_id,'actor',jsonb_build_object('kind','reviewed-data-migration','database_role',session_user),
        'previous',to_jsonb(previous),'updated',to_jsonb(updated),'evidence',item->'evidence'));
    applied:=applied+1;
  end loop;
  return jsonb_build_object('status','applied','applied',applied,'alreadyApplied',already_applied);
end $$;

-- This maintenance operation is never exposed to browser or service-role callers.
revoke all on function private.apply_keeper_evidence_review_20261001() from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then
  revoke all on function private.apply_keeper_evidence_review_20261001() from service_role;
end if; end $$;
select private.apply_keeper_evidence_review_20261001();
