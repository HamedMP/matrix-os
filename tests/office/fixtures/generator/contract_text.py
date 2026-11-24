"""Text of the sample services agreement and the edits that produce version 2.

Each block is (key, kind, number, text). Kinds: title, para, heading, clause, definition,
sub, signature. For definitions, ``number`` holds the defined term (without quotes).
The parties and companies are fictional.
"""

from __future__ import annotations

BASE: list[tuple[str, str, str, str]] = [
    ("title", "title", "", "SERVICES AGREEMENT"),
    ("date", "para", "", "This Agreement is dated 15 January 2027."),
    ("parties", "heading", "", "Parties"),
    ("party1", "sub", "(1)", "Harbourline Analytics Ltd, a company registered in England with number 08123456, whose registered office is at 12 Quay Street, Bristol BS1 4DJ (the “Customer”); and"),
    ("party2", "sub", "(2)", "Kestrel Data Services Ltd, a company registered in England with number 09876543, whose registered office is at 3 Mill Lane, Leeds LS1 5AB (the “Supplier”)."),
    ("background", "heading", "", "Background"),
    ("bgA", "sub", "(A)", "The Customer wishes to obtain data analytics services to support its commercial planning."),
    ("bgB", "sub", "(B)", "The Supplier has agreed to provide those services on the terms of this Agreement."),
    ("h1", "heading", "1.", "Definitions and interpretation"),
    ("c1.1", "clause", "1.1", "In this Agreement the following definitions apply:"),
    ("dAgreement", "definition", "Agreement", "means this services agreement, including any schedules."),
    ("dBusinessDay", "definition", "Business Day", "means a day other than a Saturday, Sunday or public holiday in England."),
    ("dChangeRequest", "definition", "Change Request", "means a written request by either party to change the scope of the Services."),
    ("dCharges", "definition", "Charges", "means the fees payable by the Customer for the Services as set out in clause 5."),
    ("dCommencement", "definition", "Commencement Date", "means 1 February 2027."),
    ("dConfidential", "definition", "Confidential Information", "means all information of a confidential nature disclosed by one party to the other, whether before or after the date of this Agreement."),
    ("dDeliverables", "definition", "Deliverables", "means all documents, reports and materials produced by the Supplier for the Customer as part of the Services."),
    ("dIPR", "definition", "Intellectual Property Rights", "means patents, copyright, database rights, trade marks and all similar rights anywhere in the world."),
    ("dServiceLevels", "definition", "Service Levels", "means the service levels set out in clause 4."),
    ("dServices", "definition", "Services", "means the data analytics services described in clause 3."),
    ("dTerm", "definition", "Term", "has the meaning given in clause 2.1."),
    ("c1.2", "clause", "1.2", "Clause headings do not affect the interpretation of this Agreement. A reference to a clause is to a clause of this Agreement."),
    ("c1.3", "clause", "1.3", "Words in the singular include the plural and words in the plural include the singular."),
    ("h2", "heading", "2.", "Term"),
    ("c2.1", "clause", "2.1", "This Agreement starts on the Commencement Date and continues for an initial period of 24 months (the “Term”), unless terminated earlier under clause 10."),
    ("c2.2", "clause", "2.2", "The Term renews automatically for successive periods of 12 months unless either party gives at least 90 days’ written notice before the end of the current period."),
    ("h3", "heading", "3.", "Services"),
    ("c3.1", "clause", "3.1", "The Supplier shall provide the Services to the Customer from the Commencement Date in accordance with this Agreement."),
    ("c3.2", "clause", "3.2", "The Supplier shall provide monthly reporting dashboards, a quarterly trend analysis and ad hoc data requests of up to 20 hours in each month."),
    ("c3.3", "clause", "3.3", "The Supplier shall use suitably skilled and experienced personnel and shall comply with the Customer’s reasonable security policies notified to it in writing."),
    ("c3.4", "clause", "3.4", "The Customer shall give the Supplier timely access to the data sources, systems and personnel reasonably required to perform the Services."),
    ("h4", "heading", "4.", "Service levels"),
    ("c4.1", "clause", "4.1", "The Supplier shall make the dashboards available 99.5% of the time in each calendar month, excluding scheduled maintenance notified at least 5 Business Days in advance."),
    ("c4.2", "clause", "4.2", "If the Supplier fails to meet the availability level in clause 4.1 in any month, the Customer is entitled to a service credit of 5% of the monthly Charges for each full 0.5% shortfall, capped at 25% of the monthly Charges."),
    ("c4.3", "clause", "4.3", "Service credits are the Customer’s sole remedy for failure to meet the Service Levels, except where clause 10.2(b) applies."),
    ("h5", "heading", "5.", "Charges and payment"),
    ("c5.1", "clause", "5.1", "The Customer shall pay the Supplier monthly Charges of £18,500 plus VAT."),
    ("c5.2", "clause", "5.2", "The Supplier shall invoice the Customer monthly in arrears. The Customer shall pay each valid invoice within 30 days of receipt."),
    ("c5.3", "clause", "5.3", "If the Customer fails to pay any amount by the due date, the Supplier may charge interest at 4% a year above the Bank of England base rate from the due date until payment."),
    ("c5.4", "clause", "5.4", "The Supplier may increase the Charges once in each year of the Term by no more than the percentage increase in the Consumer Prices Index over the preceding 12 months, by giving at least 60 days’ notice."),
    ("h6", "heading", "6.", "Intellectual property"),
    ("c6.1", "clause", "6.1", "All Intellectual Property Rights in the Deliverables shall vest in the Customer on payment of the relevant Charges."),
    ("c6.2", "clause", "6.2", "The Supplier keeps all Intellectual Property Rights in its pre-existing tools and methods and grants the Customer a non-exclusive, royalty-free licence to use them to the extent necessary to receive the Services."),
    ("h7", "heading", "7.", "Confidentiality"),
    ("c7.1", "clause", "7.1", "Each party shall keep the other party’s Confidential Information confidential and shall not use it except to perform its obligations under this Agreement."),
    ("c7.2", "clause", "7.2", "Clause 7.1 does not apply to information that is or becomes public other than through a breach of this Agreement, or that a party is required to disclose by law."),
    ("c7.3", "clause", "7.3", "The obligations in this clause 7 survive termination of this Agreement for 5 years."),
    ("h8", "heading", "8.", "Limitation of liability"),
    ("c8.1", "clause", "8.1", "Nothing in this Agreement limits or excludes liability for death or personal injury caused by negligence, or for fraud."),
    ("c8.2", "clause", "8.2", "Subject to clause 8.1, each party’s total liability in each year of the Term shall not exceed 125% of the Charges paid in that year."),
    ("c8.3", "clause", "8.3", "Subject to clause 8.1, neither party is liable for loss of profits, loss of data or any indirect or consequential loss."),
    ("h9", "heading", "9.", "Insurance"),
    ("c9.1", "clause", "9.1", "The Supplier shall maintain professional indemnity insurance of at least £2,000,000 for each claim during the Term and for 3 years after it ends."),
    ("h10", "heading", "10.", "Termination"),
    ("c10.1", "clause", "10.1", "Either party may terminate this Agreement on 90 days’ written notice, but not so as to end before the first anniversary of the Commencement Date."),
    ("c10.2", "clause", "10.2", "Either party may terminate this Agreement immediately by written notice if the other party:"),
    ("c10.2a", "sub", "(a)", "commits a material breach that is not remedied within 30 days of written notice;"),
    ("c10.2b", "sub", "(b)", "fails to meet the Service Levels under clause 4.2 in any three consecutive months; or"),
    ("c10.2c", "sub", "(c)", "becomes insolvent or enters into any arrangement with its creditors."),
    ("c10.3", "clause", "10.3", "On termination the Supplier shall return all Customer Data within 14 days, and clauses 6, 7, 8 and 12 continue in force."),
    ("h11", "heading", "11.", "Data protection"),
    ("c11.1", "clause", "11.1", "Each party shall comply with applicable data protection law. The Supplier shall process personal data only on the documented instructions of the Customer."),
    ("h12", "heading", "12.", "General"),
    ("c12.1", "clause", "12.1", "Neither party may assign this Agreement without the other party’s prior written consent, which shall not be unreasonably withheld."),
    ("c12.2", "clause", "12.2", "Notices must be in writing and delivered by hand, by recorded post or by email to the addresses set out above."),
    ("c12.3", "clause", "12.3", "This Agreement is the entire agreement between the parties and supersedes all previous discussions between them."),
    ("c12.4", "clause", "12.4", "If any provision of this Agreement is found invalid, the remaining provisions continue in force."),
    ("c12.5", "clause", "12.5", "This Agreement is governed by the law of England and Wales, and the courts of England have exclusive jurisdiction. Any dispute shall first be referred to the escalation procedure in clause 14.3."),
    ("signHead", "heading", "", "Signatures"),
    ("sign1", "signature", "", "Signed for and on behalf of Harbourline Analytics Ltd\tName: Jordan Ellis\tTitle: Chief Operating Officer"),
    ("sign2", "signature", "", "Signed for and on behalf of Kestrel Data Services Ltd\tName: Sam Okafor\tTitle: Managing Director"),
    ("sch1", "heading", "", "Schedule 1 \u2013 Service description"),
    ("sch1a", "sub", "(a)", "Monthly dashboards covering sales volume, average order value, customer retention and regional performance, refreshed by 09:00 on the third Business Day of each month."),
    ("sch1b", "sub", "(b)", "A quarterly trend analysis of no more than 15 pages, presented to the Customer\u2019s leadership team in a meeting of up to two hours."),
    ("sch1c", "sub", "(c)", "Ad hoc data requests submitted through the agreed ticketing channel, acknowledged within one Business Day and completed within five Business Days unless the parties agree otherwise."),
    ("sch1d", "sub", "(d)", "A named account manager who attends a monthly service review and reports performance against the Service Levels."),
    ("sch1e", "sub", "(e)", "Secure storage of Customer data in data centres located in the United Kingdom, with encrypted backups kept for 30 days."),
]

# Edits applied in order to produce version 2. "replace" swaps `old` for `new` in block `key`,
# "insert_after" adds `block` after `key`, "delete_sentence" removes `old` from `key`, and
# "move_after" moves block `key` so it follows block `after`.
V2_EDITS: list[dict] = [
    {"op": "replace", "key": "date", "old": "15 January 2027", "new": "22 January 2027"},
    {"op": "replace", "key": "c2.1", "old": "24 months", "new": "36 months"},
    {"op": "replace", "key": "c2.2", "old": "90 days’", "new": "60 days’"},
    {"op": "replace", "key": "c4.1", "old": "99.5%", "new": "99.9%"},
    {"op": "replace", "key": "c5.1", "old": "£18,500", "new": "£19,250"},
    {"op": "replace", "key": "c5.2", "old": "within 30 days", "new": "within 45 days"},
    {"op": "insert_after", "key": "c7.3", "block": ("c7.4", "clause", "7.4", "The Supplier shall ensure that its subcontractors are bound by confidentiality obligations no less protective than this clause 7.")},
    {"op": "replace", "key": "c8.2", "old": "125%", "new": "100%"},
    {"op": "replace", "key": "c9.1", "old": "£2,000,000 for each claim during the Term and for 3 years", "new": "£5,000,000 for each claim during the Term and for 6 years"},
    {"op": "replace", "key": "c10.2a", "old": "within 30 days", "new": "within 21 days"},
    {"op": "delete_sentence", "key": "c11.1", "old": " The Supplier shall process personal data only on the documented instructions of the Customer."},
    {"op": "move_after", "key": "dServiceLevels", "after": "dServices"},
]


def version(edits: list[dict] | None = None) -> list[tuple[str, str, str, str]]:
    blocks = list(BASE)
    for edit in edits or []:
        index = next(i for i, block in enumerate(blocks) if block[0] == edit["key"])
        key, kind, number, text = blocks[index]
        if edit["op"] in ("replace", "delete_sentence"):
            if edit["old"] not in text:
                raise ValueError(f"edit target {edit['old']!r} not in block {key}")
            blocks[index] = (key, kind, number, text.replace(edit["old"], edit.get("new", ""), 1))
        elif edit["op"] == "insert_after":
            blocks.insert(index + 1, edit["block"])
        elif edit["op"] == "move_after":
            block = blocks.pop(index)
            target = next(i for i, b in enumerate(blocks) if b[0] == edit["after"])
            blocks.insert(target + 1, block)
        else:
            raise ValueError(f"unknown edit {edit['op']}")
    return blocks
