# Synthetic source and application context
The application reads email_templates by unique template_key, not id. The fixture deployment matches source revision r581 except when audit.json has a null deploymentRevision. No later migration changes this invariant. The fixture uses InnoDB, with id PRIMARY KEY and template_key UNIQUE. No backup or approval exists. No live application verification has been performed.
An approved synthetic customization replaced old-581 with custom-9, semantic key welcome_email, body Custom greeting. Preserve it.
