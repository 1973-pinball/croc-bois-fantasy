# Draft-pick ownership reconciliation

The 2026 imported holdings match the supplied workbook and screenshot, including original pick identities. The source is **Croc Bois Fantasy Basketball Asset Management Master Sheet.xlsx**, extracted workbook SHA-256 `b617ed70f97c12c4482492902a86812e4ac2692724e372da28dfc7ad330bd6da`. This review reads the recorded ledger and draft boards; it does not modify the workbook or database.

## Verified current holdings

The only three 2026 picks held by a different franchise are:

| Pick coordinate (year–team–round) | Original franchise | Current owner | Trade | Workbook evidence |
| --- | --- | --- | --- | --- |
| `2026-2-3` | Arod | Jon | 87 | `Trades!A109:E109`; `Draft_Pick_Grids!B23/F23` |
| `2026-2-4` | Arod | Jon | 87 | `Trades!A109:E109`; `Draft_Pick_Grids!B24/F24` |
| `2026-1-8` | Jon | Shane | 92 | `Trades!A115:E115`; `Draft_Pick_Grids!F28/H28` |

Every other 2026 pick remains with its original franchise. All 104 imported picks have the expected year, original franchise, round, and owner. There are no additional recorded 2026 swaps hidden by matching counts.

These coordinates identify the source picks; the live database uses permanent pick UUIDs. The existing bootstrap stores verified opening ownership, not normalized historical trade events. This audit adds source linkage without replaying the seed or executing those transfers a second time.

| Arod | Cars/Alex | Julian/Sebastian | James | Jon | Justin/Amber | Shane | Wyn |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 11 | 13 | 13 | 13 | 14 | 13 | 14 | 13 |

These totals match `Draft_Pick_Grids!B19:I19`; the round detail is `B21:I33`. The grid is marked updated through trade 92 and signed Shane at `K1:L2`.

## Year notation and the Arod–Jon chain

Season ranges identify their **starting draft year**. Trade 80 (`Trades!C100/E100`) sends Arod's 2024 third and fourth to Jon. Trade 83 (`C104/E104`) returns 2024 third/fourth picks in exchange for Arod's 2025 third/fourth picks. Trade 87 (`C109/E109`) explicitly returns Arod's 2025 third/fourth picks to Arod in exchange for his 2026 third/fourth picks.

The final boards corroborate the returned original picks: `2024 Draft!C24:D24` and `C27:D27`, and `2025 Draft!C20:D20` and `C31:D31`, all show Arod as original and current owner. Trade 83 must not be applied again to 2026 merely because its season label contains “2026.” Its 2024 return leg does not explicitly name the original franchise, so this attribution uses the preceding trade and final board together.

## Future reference holdings

`Draft_Pick_Grids!A4:I17` records one 2027 pick in each of 13 rounds for every franchise, with totals of 13 at `B3:I3`. No 2027 or later pick transfer appears in the supplied trade ledger through trade 92. The 2027 holdings are a workbook reference, not live database pick assets or an established draft order. At the time of this audit, `data/league.json` contains only the 104 current 2026 picks.

The `2026 Draft` tab is the workspace for the upcoming draft. Its blank player inputs and A–H owner placeholders await future selections and draft order. Current pick ownership is verified from the pick grid and trade evidence above. No 2028 or later pick reference was found in the trade ledger or pick grid.

## Historical coverage and discrepancies

All eight 2018–2025 draft boards contain 104 recorded selections. The 2022–2025 boards have explicit original-owner and current-owner columns. All 416 corresponding public draft records agree with those columns after known franchise aliases are normalized. The 2018–2021 boards combine recipient names and ownership annotations; public `originalOwner` fields repeat that combined text in some records. They must not be treated as independently verified original-franchise identities.

The count grid covers 2019–2027, with no 2018 grid. It does not consistently reflect final historical boards:

| Draft year | Grid round-detail total | Final board selections | Owner/round differences |
| --- | ---: | ---: | --- |
| 2025 | 104 | 104 | 12 cells; later trades 90/91 are not fully reflected |
| 2024 | 104 | 104 | 10 cells; trade 84 and the deferred sixth-round arrangement differ |
| 2023 | 104 | 104 | None by owner/round count; equal-round swaps still require identities |
| 2022 | 104 | 104 | `H90/I90`: grid gives Shane 2 and Wyn 0 seventh-round picks; board gives each 1 |
| 2021 | 104 | 104 | 17 cells; grid and final board differ |
| 2020 | 105 | 104 | 7 cells; grid contains one more pick than the completed board |
| 2019 | 69 | 104 | The grid is not a complete 104-pick ownership snapshot; zeros cannot be interpreted as proof that original picks did not exist |
| 2018 | No grid | 104 | Ownership reconstruction relies on annotations and trade evidence |

The comparison includes all recorded draft-board appearances, including keepers. It does not assume that every older grid was intended to count the same set of available picks. Historical grid ranges are `B36:I48` (2025), `B51:I63` (2024), `B67:I79` (2023), `B84:I96` (2022), `B100:I112` (2021), `B116:I128` (2020), and `B132:I144` (2019).

### Swaps that totals alone conceal

These 2025 original identities are preserved in both the final draft board and public history:

| Trade | Original identities exchanged | Final-board evidence |
| --- | --- | --- |
| 88 (`Trades!C110/E110`) | Arod and Shane swap their own seventh and eighth | `2025 Draft!C52:D52`, `C57:D58`, `C63:D63` |
| 89 (`Trades!C111/E111`) | Julian and Wyn swap their own fourth and fifth | `2025 Draft!C30:D30`, `C33:D34`, `C37:D37` |
| 91 (`Trades!C113/E113`) | James's third-round pick 22 and Julian's third-round pick 17 exchange owners | `2025 Draft!B18:D18`, `B23:D23` |

Trade 91 also exchanges James's seventh-round pick 54 for Julian's tenth-round pick 80, visible at `2025 Draft!B55:D55` and `B81:D81`. Trade 90 exchanges James's fifth/eighth for Jon's fourth/twelfth, visible at `2025 Draft!C29:D29`, `C39:D39`, `C60:D60`, and `C93:D93`. Those later exchanges explain the 2025 grid differences even though each team's total remains unchanged.

In 2024, trade 84 (`Trades!C106/E106`) exchanges James's sixth/seventh with Julian's fifth/eleventh. Trade 85 explicitly notes a grid error and defers the sixth-round pick to 2025 (`Trades!F107`); `2025 Draft!C46:D46` records Wyn's original sixth with Jon. The 2024 round-count grid should not override that documented deferral and the completed draft boards.

## Limits of a historical ledger replay

Voided trades 16 and 19 (`Trades!F17/F20`) are excluded. Options in trades 10, 73, and 75 are not presumed exercised. Older trades sometimes omit which of several same-round picks was conveyed: trades 12 and 17 explicitly refer to coin flips (`Trades!F13/F18`), and the ledger does not supply a standalone resolution for every such choice. Consequently, this audit verifies the current 2026 identities and compares the recorded historical evidence; it does not claim a fully unambiguous replay of every historical pick from trade prose alone.

The machine-readable public evidence is `data/draft-pick-evidence.json`. It includes only league franchise IDs, pick identities, trade numbers, and source references. It contains no authentication or member-account IDs.
