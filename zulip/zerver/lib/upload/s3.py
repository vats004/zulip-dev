import logging
import os
import secrets
from collections.abc import Callable, Iterator
from datetime import datetime
from typing import IO, Any, BinaryIO, Literal
from urllib.parse import urljoin, urlsplit, urlunsplit

import boto3
import botocore
from botocore.client import Config
from django.conf import settings
from mypy_boto3_s3.service_resource import Bucket
from typing_extensions import override

from zerver.lib.thumbnail import resize_logo, resize_realm_icon
from zerver.lib.upload.base import INLINE_MIME_TYPES, ZulipUploadBackend
from zerver.models import Realm, RealmEmoji, UserProfile

# Duration that the signed upload URLs that we redirect to when
# accessing uploaded files are available for clients to fetch before
# they expire.
SIGNED_UPLOAD_URL_DURATION = 60

# Performance note:
#
# For writing files to S3, the file could either be stored in RAM
# (if it is less than 2.5MiB or so) or an actual temporary file on disk.
#
# Because we set FILE_UPLOAD_MAX_MEMORY_SIZE to 0, only the latter case
# should occur in practice.
#
# This is great, because passing the pseudofile object that Django gives
# you to boto would be a pain.

# To come up with a s3 key we randomly generate a "directory". The
# "file name" is the original filename provided by the user run
# through a sanitization function.


# https://github.com/boto/botocore/issues/2644 means that the IMDS
# request _always_ pulls from the environment.  Monkey-patch the
# `should_bypass_proxies` function if we need to skip them, based
# on S3_SKIP_PROXY.
if settings.S3_SKIP_PROXY is True:  # nocoverage
    botocore.utils.should_bypass_proxies = lambda url: True


def get_bucket(bucket_name: str, authed: bool = True) -> Bucket:
    return boto3.resource(
        "s3",
        aws_access_key_id=settings.S3_KEY if authed else None,
        aws_secret_access_key=settings.S3_SECRET_KEY if authed else None,
        region_name=settings.S3_REGION,
        endpoint_url=settings.S3_ENDPOINT_URL,
        config=Config(
            signature_version=None if authed else botocore.UNSIGNED,
            s3={"addressing_style": settings.S3_ADDRESSING_STYLE},
        ),
    ).Bucket(bucket_name)


def upload_image_to_s3(
    bucket: Bucket,
    file_name: str,
    content_type: str | None,
    user_profile: UserProfile | None,
    contents: bytes,
    *,
    storage_class: Literal[
        "GLACIER_IR",
        "INTELLIGENT_TIERING",
        "ONEZONE_IA",
        "REDUCED_REDUNDANCY",
        "STANDARD",
        "STANDARD_IA",
    ] = "STANDARD",
    cache_control: str | None = None,
    extra_metadata: dict[str, str] | None = None,
) -> None:
    key = bucket.Object(file_name)
    metadata: dict[str, str] = {}
    if user_profile:
        metadata["user_profile_id"] = str(user_profile.id)
        metadata["realm_id"] = str(user_profile.realm_id)
    if extra_metadata is not None:
        metadata.update(extra_metadata)

    extras = {}
    if content_type is None:  # nocoverage
        content_type = ""
    if content_type not in INLINE_MIME_TYPES:
        extras["ContentDisposition"] = "attachment"
    if cache_control is not None:
        extras["CacheControl"] = cache_control

    key.put(
        Body=contents,
        Metadata=metadata,
        ContentType=content_type,
        StorageClass=storage_class,
        **extras,  # type: ignore[arg-type] # The dynamic kwargs here confuse mypy.
    )


def get_signed_upload_url(path: str, force_download: bool = False) -> str:
    client = get_bucket(settings.S3_AUTH_UPLOADS_BUCKET).meta.client
    params = {
        "Bucket": settings.S3_AUTH_UPLOADS_BUCKET,
        "Key": path,
    }
    if force_download:
        params["ResponseContentDisposition"] = "attachment"

    return client.generate_presigned_url(
        ClientMethod="get_object",
        Params=params,
        ExpiresIn=SIGNED_UPLOAD_URL_DURATION,
        HttpMethod="GET",
    )


class S3UploadBackend(ZulipUploadBackend):
    def __init__(self) -> None:
        self.avatar_bucket = get_bucket(settings.S3_AVATAR_BUCKET)
        self.uploads_bucket = get_bucket(settings.S3_AUTH_UPLOADS_BUCKET)
        self.public_upload_url_base = self.construct_public_upload_url_base()

    def delete_file_from_s3(self, path_id: str, bucket: Bucket) -> bool:
        key = bucket.Object(path_id)

        try:
            key.load()
        except botocore.exceptions.ClientError:
            file_name = path_id.split("/")[-1]
            logging.warning(
                "%s does not exist. Its entry in the database will be removed.", file_name
            )
            return False
        key.delete()
        return True

    def construct_public_upload_url_base(self) -> str:
        # Return the pattern for public URL for a key in the S3 Avatar bucket.
        # For Amazon S3 itself, this will return the following:
        #     f"https://{self.avatar_bucket.name}.{network_location}/{key}"
        #
        # However, we need this function to properly handle S3 style
        # file upload backends that Zulip supports, which can have a
        # different URL format. Configuring no signature and providing
        # no access key makes `generate_presigned_url` just return the
        # normal public URL for a key.
        #
        # It unfortunately takes 2ms per query to call
        # generate_presigned_url. Since we need to potentially compute
        # hundreds of avatar URLs in single `GET /messages` request,
        # we instead back-compute the URL pattern here.

        # The S3_AVATAR_PUBLIC_URL_PREFIX setting is used to override
        # this prefix, for instance if a CloudFront distribution is
        # used.
        if settings.S3_AVATAR_PUBLIC_URL_PREFIX is not None:
            prefix = settings.S3_AVATAR_PUBLIC_URL_PREFIX
            if not prefix.endswith("/"):
                prefix += "/"
            return prefix

        DUMMY_KEY = "dummy_key_ignored"

        # We do not access self.avatar_bucket.meta.client directly,
        # since that client is auth'd, and we want only the direct
        # unauthed endpoint here.
        client = get_bucket(self.avatar_bucket.name, authed=False).meta.client
        dummy_signed_url = client.generate_presigned_url(
            ClientMethod="get_object",
            Params={
                "Bucket": self.avatar_bucket.name,
                "Key": DUMMY_KEY,
            },
            ExpiresIn=0,
        )
        split_url = urlsplit(dummy_signed_url)
        assert split_url.path.endswith(f"/{DUMMY_KEY}")

        return urlunsplit(
            (split_url.scheme, split_url.netloc, split_url.path[: -len(DUMMY_KEY)], "", "")
        )

    @override
    def get_public_upload_root_url(self) -> str:
        return self.public_upload_url_base

    def get_public_upload_url(
        self,
        key: str,
    ) -> str:
        assert not key.startswith("/")
        return urljoin(self.public_upload_url_base, key)

    @override
    def generate_message_upload_path(self, realm_id: str, sanitized_file_name: str) -> str:
        return "/".join(
            [
                realm_id,
                secrets.token_urlsafe(18),
                sanitized_file_name,
            ]
        )

    @override
    def upload_message_attachment(
        self,
        path_id: str,
        content_type: str,
        file_data: bytes,
        user_profile: UserProfile | None,
    ) -> None:
        upload_image_to_s3(
            self.uploads_bucket,
            path_id,
            content_type,
            user_profile,
            file_data,
            storage_class=settings.S3_UPLOADS_STORAGE_CLASS,
        )

    @override
    def save_attachment_contents(self, path_id: str, filehandle: BinaryIO) -> None:
        for chunk in self.uploads_bucket.Object(path_id).get()["Body"]:
            filehandle.write(chunk)

    @override
    def delete_message_attachment(self, path_id: str) -> bool:
        return self.delete_file_from_s3(path_id, self.uploads_bucket)

    @override
    def delete_message_attachments(self, path_ids: list[str]) -> None:
        self.uploads_bucket.delete_objects(
            Delete={"Objects": [{"Key": path_id} for path_id in path_ids]}
        )

    @override
    def all_message_attachments(
        self, include_thumbnails: bool = False
    ) -> Iterator[tuple[str, datetime]]:
        client = self.uploads_bucket.meta.client
        paginator = client.get_paginator("list_objects_v2")
        page_iterator = paginator.paginate(Bucket=self.uploads_bucket.name)

        for page in page_iterator:
            if page["KeyCount"] > 0:
                for item in page["Contents"]:
                    if not include_thumbnails and item["Key"].startswith("thumbnail/"):
                        continue
                    yield (
                        item["Key"],
                        item["LastModified"],
                    )

    @override
    def get_avatar_url(self, hash_key: str, medium: bool = False) -> str:
        return self.get_public_upload_url(self.get_avatar_path(hash_key, medium))

    @override
    def get_avatar_contents(self, file_path: str) -> tuple[bytes, str]:
        key = self.avatar_bucket.Object(file_path + ".original")
        image_data = key.get()["Body"].read()
        content_type = key.content_type
        return image_data, content_type

    @override
    def upload_single_avatar_image(
        self,
        file_path: str,
        *,
        user_profile: UserProfile,
        image_data: bytes,
        content_type: str | None,
        future: bool = True,
    ) -> None:
        extra_metadata = {"avatar_version": str(user_profile.avatar_version + (1 if future else 0))}
        upload_image_to_s3(
            self.avatar_bucket,
            file_path,
            content_type,
            user_profile,
            image_data,
            extra_metadata=extra_metadata,
            cache_control="public, max-age=31536000, immutable",
        )

    @override
    def delete_avatar_image(self, path_id: str) -> None:
        self.delete_file_from_s3(path_id + ".original", self.avatar_bucket)
        self.delete_file_from_s3(self.get_avatar_path(path_id, True), self.avatar_bucket)
        self.delete_file_from_s3(self.get_avatar_path(path_id, False), self.avatar_bucket)

    @override
    def get_realm_icon_url(self, realm_id: int, version: int) -> str:
        public_url = self.get_public_upload_url(f"{realm_id}/realm/icon.png")
        return public_url + f"?version={version}"

    @override
    def upload_realm_icon_image(
        self, icon_file: IO[bytes], user_profile: UserProfile, content_type: str
    ) -> None:
        s3_file_name = os.path.join(self.realm_avatar_and_logo_path(user_profile.realm), "icon")

        image_data = icon_file.read()
        upload_image_to_s3(
            self.avatar_bucket,
            s3_file_name + ".original",
            content_type,
            user_profile,
            image_data,
        )

        resized_data = resize_realm_icon(image_data)
        upload_image_to_s3(
            self.avatar_bucket,
            s3_file_name + ".png",
            "image/png",
            user_profile,
            resized_data,
        )
        # See avatar_url in avatar.py for URL.  (That code also handles the case
        # that users use gravatar.)

    @override
    def get_realm_logo_url(self, realm_id: int, version: int, night: bool) -> str:
        if not night:
            file_name = "logo.png"
        else:
            file_name = "night_logo.png"
        public_url = self.get_public_upload_url(f"{realm_id}/realm/{file_name}")
        return public_url + f"?version={version}"

    @override
    def upload_realm_logo_image(
        self, logo_file: IO[bytes], user_profile: UserProfile, night: bool, content_type: str
    ) -> None:
        if night:
            basename = "night_logo"
        else:
            basename = "logo"
        s3_file_name = os.path.join(self.realm_avatar_and_logo_path(user_profile.realm), basename)

        image_data = logo_file.read()
        upload_image_to_s3(
            self.avatar_bucket,
            s3_file_name + ".original",
            content_type,
            user_profile,
            image_data,
        )

        resized_data = resize_logo(image_data)
        upload_image_to_s3(
            self.avatar_bucket,
            s3_file_name + ".png",
            "image/png",
            user_profile,
            resized_data,
        )
        # See avatar_url in avatar.py for URL.  (That code also handles the case
        # that users use gravatar.)

    @override
    def get_emoji_url(self, emoji_file_name: str, realm_id: int, still: bool = False) -> str:
        if still:
            emoji_path = RealmEmoji.STILL_PATH_ID_TEMPLATE.format(
                realm_id=realm_id,
                emoji_filename_without_extension=os.path.splitext(emoji_file_name)[0],
            )
            return self.get_public_upload_url(emoji_path)
        else:
            emoji_path = RealmEmoji.PATH_ID_TEMPLATE.format(
                realm_id=realm_id, emoji_file_name=emoji_file_name
            )
            return self.get_public_upload_url(emoji_path)

    @override
    def upload_single_emoji_image(
        self, path: str, content_type: str | None, user_profile: UserProfile, image_data: bytes
    ) -> None:
        upload_image_to_s3(
            self.avatar_bucket,
            path,
            content_type,
            user_profile,
            image_data,
            cache_control="public, max-age=31536000, immutable",
        )

    @override
    def get_export_tarball_url(self, realm: Realm, export_path: str) -> str:
        # export_path has a leading /
        return self.get_public_upload_url(export_path[1:])

    @override
    def upload_export_tarball(
        self,
        realm: Realm | None,
        tarball_path: str,
        percent_callback: Callable[[Any], None] | None = None,
    ) -> str:
        # We use the avatar bucket, because it's world-readable.
        key = self.avatar_bucket.Object(
            os.path.join("exports", secrets.token_hex(16), os.path.basename(tarball_path))
        )

        if percent_callback is None:
            key.upload_file(Filename=tarball_path)
        else:
            key.upload_file(Filename=tarball_path, Callback=percent_callback)

        public_url = self.get_public_upload_url(key.key)
        return public_url

    @override
    def delete_export_tarball(self, export_path: str) -> str | None:
        assert export_path.startswith("/")
        path_id = export_path[1:]
        if self.delete_file_from_s3(path_id, self.avatar_bucket):
            return export_path
        return None
