# See https://zulip.readthedocs.io/en/latest/subsystems/onboarding-steps.html
# for documentation on this subsystem.
from dataclasses import dataclass
from typing import Any

from django.conf import settings

from zerver.models import OnboardingStep, UserProfile


@dataclass
class OneTimeNotice:
    name: str

    def to_dict(self) -> dict[str, str]:
        return {
            "type": "one_time_notice",
            "name": self.name,
        }


ONE_TIME_NOTICES: list[OneTimeNotice] = [
    OneTimeNotice(
        name="visibility_policy_banner",
    ),
    OneTimeNotice(
        name="intro_inbox_view_modal",
    ),
    OneTimeNotice(
        name="intro_recent_view_modal",
    ),
    OneTimeNotice(
        name="first_stream_created_banner",
    ),
    OneTimeNotice(
        name="jump_to_conversation_banner",
    ),
    OneTimeNotice(
        name="non_interleaved_view_messages_fading",
    ),
    OneTimeNotice(
        name="interleaved_view_messages_fading",
    ),
]

# We may introduce onboarding step of types other than 'one time notice'
# in future. Earlier, we had 'hotspot' and 'one time notice' as the two
# types. We can simply do:
# ALL_ONBOARDING_STEPS: List[Union[OneTimeNotice, OtherType]]
# to avoid API changes when new type is introduced in the future.
ALL_ONBOARDING_STEPS: list[OneTimeNotice] = ONE_TIME_NOTICES


def get_next_onboarding_steps(user: UserProfile) -> list[dict[str, Any]]:
    # If a Zulip server has disabled the tutorial, never send any
    # onboarding steps.
    if not settings.TUTORIAL_ENABLED:
        return []

    seen_onboarding_steps = frozenset(
        OnboardingStep.objects.filter(user=user).values_list("onboarding_step", flat=True)
    )

    onboarding_steps: list[dict[str, Any]] = []
    for one_time_notice in ONE_TIME_NOTICES:
        if one_time_notice.name in seen_onboarding_steps:
            continue
        onboarding_steps.append(one_time_notice.to_dict())

    return onboarding_steps


def copy_onboarding_steps(source_profile: UserProfile, target_profile: UserProfile) -> None:
    for onboarding_step in frozenset(OnboardingStep.objects.filter(user=source_profile)):
        OnboardingStep.objects.create(
            user=target_profile,
            onboarding_step=onboarding_step.onboarding_step,
            timestamp=onboarding_step.timestamp,
        )

    # TODO: The 'tutorial_status' field of 'UserProfile' model
    # is no longer used. Remove it.
    target_profile.tutorial_status = source_profile.tutorial_status
    target_profile.save(update_fields=["tutorial_status"])
