# Generated by Django 1.11.4 on 2017-09-04 22:48
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0106_subscription_push_notifications"),
    ]

    operations = [
        migrations.CreateModel(
            name="MultiuseInvite",
            fields=[
                (
                    "id",
                    models.AutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                (
                    "realm",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to="zerver.Realm"
                    ),
                ),
                (
                    "referred_by",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL
                    ),
                ),
                ("streams", models.ManyToManyField(to="zerver.Stream")),
            ],
        ),
    ]
