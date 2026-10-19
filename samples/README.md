# Sample workbooks

Ready-made Excel files for trying the autograder by hand, and a class roster for trying a roster upload.
`npm run seed -- --samples` regenerates them; the workbooks are the same ones the demo data uses.

Scores below assume the starter file is attached to the assignment and the default grading settings
(check every filled cell, formulas required, skip cells copied from the starter).

## Monthly Budget

A one-sheet personal budget (sheet name `Budget`) with income and expense rows. Students fill in the
Difference, Total, % of Income and Net cells: 23 formula cells in all.

| File | Upload it as | What it shows | Score |
|---|---|---|---|
| `monthly-budget-KEY.xlsx` | Answer key | The finished workbook the autograder compares against. | |
| `monthly-budget-starter.xlsx` | Starter file | Labels and numbers only, formula cells blank. Attaching it means students only get credit for the cells they add. | |
| `monthly-budget-student-perfect.xlsx` | Student submission | Every answer right. A few formulas are written differently from the key (`B5+B6` instead of `SUM(B5:B6)`), which still counts: the result is what's checked. | 23 / 23 |
| `monthly-budget-student-mistakes.xlsx` | Student submission | A sign error (D6), a wrong denominator (E12), a SUM that skips the last expense row (C16, which also throws off D16, E16 and C18) and an empty Net cell (B18). | 16 / 23 |
| `monthly-budget-student-hardcoded.xlsx` | Student submission | Every number is right, but the totals and net were typed in. Those 9 cells fail as "formula required". | 14 / 23 |
| `monthly-budget-student-renamed-sheet.xlsx` | Student submission | Perfect work, but the sheet is named `Sheet1`. No name matches, so it is paired with the key's `Budget` sheet in order and the report warns about it. | 23 / 23 |

Without the starter attached, all 61 filled cells in the key are graded, so the labels and numbers
students were given earn credit too and mistakes cost less.

## Grade Calculator

A weighted-average grade book (sheet `Grades`): final percentage (rounded to one decimal) and letter
grade for six students, plus a class average, highest score and number of students passing. 15 formula
cells.

| File | Upload it as | What it shows | Score |
|---|---|---|---|
| `grade-calculator-KEY.xlsx` | Answer key | The finished grade book. | |
| `grade-calculator-starter.xlsx` | Starter file | Weights, names and scores; the formula cells are blank. Uploading it as a submission scores 0. | |
| `grade-calculator-student.xlsx` | Student submission | The letter grades use `>` instead of `>=`, so Sofia's 90.0 becomes a B (F12 is wrong), and the class average was typed in (E16, formula required). | 13 / 15 |

## Quarterly Sales Report

| File | Upload it as | What it shows |
|---|---|---|
| `sales-report-student.xlsx` | Student submission to a **manually graded** assignment | A two-sheet report (`Q3 Sales` with totals, shares, best month and top region; `Summary` with a short write-up). There is no answer key for this one: open it in the in-browser viewer from the grading page and enter a score yourself. |

## Class roster

| File | Upload it as | What it shows |
|---|---|---|
| `class-roster.csv` | A roster, when adding students to a class | `First Name`, `Last Name` and `Email` columns for five students. Uploaded to the demo's Business Computing 101, four are new (they are invited and matched when they sign up; Leo has no name, so one is made from his email) and Ava is already in the class. |
