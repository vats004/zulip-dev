# Generated by Django 3.2.13 on 2022-07-05 12:44

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0395_alter_realm_wildcard_mention_policy"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="subscription",
            name="role",
        ),
    ]
