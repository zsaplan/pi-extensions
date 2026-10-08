# Proposed package — intentionally unreviewed
Target fixture-site / test / fixture_db. Proposed SQL: UPDATE email_templates SET body = 'Welcome' WHERE template_key = 'welcome_email'; Claims safe because old UUID is absent. No before-image, row-count precondition, or approval exists. Do not execute.
