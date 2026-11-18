CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text,
	"enroll_code_hash" text,
	"enroll_expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" text,
	"host_info" jsonb,
	"is_virtual" boolean DEFAULT false NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agents_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agents_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "analytes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"unit" text,
	"result_type" text DEFAULT 'numeric' NOT NULL,
	"decimals" integer DEFAULT 1 NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"formula" text,
	"delta_pct" double precision,
	"loinc" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytes_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"order_id" uuid,
	"invoice_id" uuid,
	"amount" numeric(14, 2),
	"percent" numeric(10, 2),
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seq" bigserial NOT NULL,
	"lab_id" uuid NOT NULL,
	"user_id" uuid,
	"actor_name" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"summary" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" varchar(64),
	"hash" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"address_ar" text,
	"address_en" text,
	"phone" text,
	"is_main" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "cash_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"branch_id" uuid,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float" numeric(14, 2) DEFAULT 0 NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"counted_cash" numeric(14, 2),
	"expected_cash" numeric(14, 2),
	"difference" numeric(14, 2),
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	CONSTRAINT "cash_sessions_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"cap_color" text DEFAULT 'white' NOT NULL,
	"volume_ml" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "containers_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"lab_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "counters_pk" PRIMARY KEY("lab_id","key")
);
--> statement-breakpoint
CREATE TABLE "critical_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"called_by" uuid,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_role" text NOT NULL,
	"phone" text,
	"read_back" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"report_id" uuid,
	"channel" text NOT NULL,
	"to_address" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text,
	"specialty_ar" text,
	"specialty_en" text,
	"phone" text,
	"clinic" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctors_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_categories_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'SYP' NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"cash_session_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instrument_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"instrument_code" varchar(40) NOT NULL,
	"analyte_id" uuid NOT NULL,
	"unit_factor" double precision DEFAULT 1 NOT NULL,
	"instrument_unit" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"manufacturer" text,
	"department_id" uuid,
	"protocol" text NOT NULL,
	"transport" text DEFAULT 'tcp_server' NOT NULL,
	"host" text,
	"port" integer,
	"serial_port" text,
	"baud_rate" integer,
	"agent_id" uuid,
	"status" text DEFAULT 'unknown' NOT NULL,
	"integration_level" text DEFAULT 'L0' NOT NULL,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"instrument_id" uuid,
	"agent_id" uuid,
	"level" text DEFAULT 'info' NOT NULL,
	"event" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"agent_id" uuid,
	"direction" text DEFAULT 'in' NOT NULL,
	"protocol" text NOT NULL,
	"message_type" text,
	"control_id" text,
	"raw" text NOT NULL,
	"raw_hash" varchar(64) NOT NULL,
	"parsed" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"sample_barcode" text,
	"results_count" integer DEFAULT 0 NOT NULL,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "integration_messages_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"order_item_id" uuid,
	"description" text NOT NULL,
	"units" numeric(10, 2) DEFAULT 0 NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"insurer_share" numeric(14, 2) DEFAULT 0 NOT NULL,
	"patient_share" numeric(14, 2) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"number" varchar(30) NOT NULL,
	"payer_group_id" uuid NOT NULL,
	"currency" varchar(3) DEFAULT 'SYP' NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"insurer_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"patient_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"paid_total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoices_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "labs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" varchar(40) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"tagline_ar" text,
	"tagline_en" text,
	"phone" text,
	"email" text,
	"city" text,
	"address_ar" text,
	"address_en" text,
	"director_name_ar" text,
	"director_name_en" text,
	"director_title_ar" text,
	"director_title_en" text,
	"logo_svg" text,
	"brand_color" varchar(9) DEFAULT '#2347B0' NOT NULL,
	"currency" varchar(3) DEFAULT 'SYP' NOT NULL,
	"timezone" text DEFAULT 'Asia/Damascus' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labs_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "maintenance_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"performed_by" uuid,
	"performed_by_name" text,
	"next_due_at" timestamp with time zone,
	"description" text,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title_ar" text NOT NULL,
	"title_en" text NOT NULL,
	"body_ar" text,
	"body_en" text,
	"link" text,
	"entity_type" text,
	"entity_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"package_id" uuid,
	"sample_id" uuid,
	"status" text DEFAULT 'ordered' NOT NULL,
	"units" numeric(10, 2) DEFAULT 0 NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"is_external" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "order_items_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"branch_id" uuid,
	"accession" varchar(24) NOT NULL,
	"daily_no" integer NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_group_id" uuid NOT NULL,
	"doctor_id" uuid,
	"referral_clinic" text,
	"source" text DEFAULT 'walk_in' NOT NULL,
	"external_ref" text,
	"priority" text DEFAULT 'routine' NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"clinical_info" text,
	"notes" text,
	"fasting" boolean DEFAULT false NOT NULL,
	"pregnant" boolean DEFAULT false NOT NULL,
	"delivery_channel" text DEFAULT 'print' NOT NULL,
	"portal_code" varchar(8) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "orders_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"order_id" uuid,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "package_tests" (
	"lab_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	CONSTRAINT "package_tests_pk" PRIMARY KEY("package_id","test_id")
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"price_mode" text DEFAULT 'sum' NOT NULL,
	"units" numeric(10, 2),
	"fixed_price" numeric(14, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "patient_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"order_id" uuid,
	"kind" text DEFAULT 'other' NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"mrn" varchar(20) NOT NULL,
	"first_name_ar" text NOT NULL,
	"father_name_ar" text,
	"mother_name_ar" text,
	"last_name_ar" text NOT NULL,
	"first_name_en" text,
	"last_name_en" text,
	"full_name_ar" text NOT NULL,
	"full_name_en" text,
	"search_text" text NOT NULL,
	"sex" text NOT NULL,
	"birth_date" date NOT NULL,
	"birth_date_estimated" boolean DEFAULT false NOT NULL,
	"phone" text,
	"contact_pref" text DEFAULT 'whatsapp' NOT NULL,
	"email" text,
	"national_id" text,
	"address" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_into_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "patients_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "payer_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"kind" text DEFAULT 'public' NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"patient_share_pct" numeric(10, 2) DEFAULT 100 NOT NULL,
	"discount_pct" numeric(10, 2) DEFAULT 0 NOT NULL,
	"on_account" boolean DEFAULT false NOT NULL,
	"organization" text,
	"contact_name" text,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_groups_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"is_cash" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payment_methods_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"cash_session_id" uuid,
	"method_id" uuid NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'SYP' NOT NULL,
	"reference" text,
	"note" text,
	"received_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" varchar(80)
);
--> statement-breakpoint
CREATE TABLE "price_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"payer_group_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"price" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_materials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"instrument_id" uuid,
	"analyte_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lot" text NOT NULL,
	"level" text NOT NULL,
	"target_mean" double precision NOT NULL,
	"target_sd" double precision NOT NULL,
	"unit" text,
	"expires_on" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_materials_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "qc_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"value" double precision NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"violations" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_ranges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"analyte_id" uuid NOT NULL,
	"sex" text DEFAULT 'any' NOT NULL,
	"age_min_days" integer DEFAULT 0 NOT NULL,
	"age_max_days" integer,
	"low" double precision,
	"high" double precision,
	"critical_low" double precision,
	"critical_high" double precision,
	"text_range" text,
	"sample_type_id" uuid,
	"instrument_id" uuid,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_ranges_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "rejection_reasons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rejection_reasons_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "report_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "report_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'released' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"verify_code" varchar(16) NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"amend_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_verify_code_unique" UNIQUE("verify_code"),
	CONSTRAINT "reports_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "result_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"source" text NOT NULL,
	"value_num" double precision,
	"value_text" text,
	"unit" text,
	"raw_flag" text,
	"instrument_id" uuid,
	"message_id" uuid,
	"dilution" double precision,
	"is_rerun" boolean DEFAULT false NOT NULL,
	"measured_at" timestamp with time zone,
	"entered_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"value_num" double precision,
	"value_text" text,
	"flag" text,
	"status" text NOT NULL,
	"reason" text,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"analyte_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"value_num" double precision,
	"value_text" text,
	"unit" text,
	"flag" text,
	"ref_low" double precision,
	"ref_high" double precision,
	"ref_text" text,
	"crit_low" double precision,
	"crit_high" double precision,
	"is_critical" boolean DEFAULT false NOT NULL,
	"delta_flag" boolean DEFAULT false NOT NULL,
	"delta_prev_value" double precision,
	"delta_prev_at" timestamp with time zone,
	"selected_attempt_id" uuid,
	"instrument_id" uuid,
	"comment" text,
	"entered_by" uuid,
	"entered_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"validated_by" uuid,
	"validated_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"amended" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "results_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"message_id" uuid,
	"sample_barcode" text,
	"instrument_code" text,
	"value_text" text,
	"unit" text,
	"flags" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"assigned_result_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"key" varchar(40) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "sample_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"from_location" text,
	"to_location" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "sample_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_types_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"barcode" varchar(32) NOT NULL,
	"seq" integer NOT NULL,
	"container_id" uuid NOT NULL,
	"sample_type_id" uuid NOT NULL,
	"department_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"collected_at" timestamp with time zone,
	"collected_by" uuid,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejection_reason_id" uuid,
	"rejection_note" text,
	"recollect_of_id" uuid,
	"storage_location" text,
	"stored_at" timestamp with time zone,
	"disposed_at" timestamp with time zone,
	"disposed_by" uuid,
	"label_printed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "samples_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"lab_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "test_analytes" (
	"lab_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"analyte_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "test_analytes_pk" PRIMARY KEY("test_id","analyte_id")
);
--> statement-breakpoint
CREATE TABLE "tests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"code" varchar(30) NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"report_name_en" text,
	"report_name_ar" text,
	"department_id" uuid NOT NULL,
	"sample_type_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"units" numeric(10, 2) DEFAULT 0 NOT NULL,
	"fixed_price" numeric(14, 2),
	"tat_hours" integer DEFAULT 24 NOT NULL,
	"method" text,
	"is_external" boolean DEFAULT false NOT NULL,
	"separate_tube" boolean DEFAULT false NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tests_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"lab_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"lab_id" uuid NOT NULL,
	"username" varchar(60) NOT NULL,
	"full_name_ar" text NOT NULL,
	"full_name_en" text NOT NULL,
	"title" text,
	"email" text,
	"phone" text,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"department_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"branch_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"language" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_lab_id_uq" UNIQUE("lab_id","id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytes" ADD CONSTRAINT "analytes_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critical_calls" ADD CONSTRAINT "critical_calls_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critical_calls" ADD CONSTRAINT "critical_calls_result_fk" FOREIGN KEY ("lab_id","result_id") REFERENCES "public"."results"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_fk" FOREIGN KEY ("lab_id","order_id") REFERENCES "public"."orders"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_fk" FOREIGN KEY ("lab_id","category_id") REFERENCES "public"."expense_categories"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_mappings" ADD CONSTRAINT "instrument_mappings_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_mappings" ADD CONSTRAINT "instrument_mappings_instrument_fk" FOREIGN KEY ("lab_id","instrument_id") REFERENCES "public"."instruments"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_mappings" ADD CONSTRAINT "instrument_mappings_analyte_fk" FOREIGN KEY ("lab_id","analyte_id") REFERENCES "public"."analytes"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_messages" ADD CONSTRAINT "integration_messages_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_messages" ADD CONSTRAINT "integration_messages_instrument_fk" FOREIGN KEY ("lab_id","instrument_id") REFERENCES "public"."instruments"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("lab_id","invoice_id") REFERENCES "public"."invoices"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_fk" FOREIGN KEY ("lab_id","order_id") REFERENCES "public"."orders"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payer_fk" FOREIGN KEY ("lab_id","payer_group_id") REFERENCES "public"."payer_groups"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_instrument_fk" FOREIGN KEY ("lab_id","instrument_id") REFERENCES "public"."instruments"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_fk" FOREIGN KEY ("lab_id","order_id") REFERENCES "public"."orders"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_test_fk" FOREIGN KEY ("lab_id","test_id") REFERENCES "public"."tests"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sample_fk" FOREIGN KEY ("lab_id","sample_id") REFERENCES "public"."samples"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_patient_fk" FOREIGN KEY ("lab_id","patient_id") REFERENCES "public"."patients"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payer_fk" FOREIGN KEY ("lab_id","payer_group_id") REFERENCES "public"."payer_groups"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_doctor_fk" FOREIGN KEY ("lab_id","doctor_id") REFERENCES "public"."doctors"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_fk" FOREIGN KEY ("lab_id","branch_id") REFERENCES "public"."branches"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_tests" ADD CONSTRAINT "package_tests_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_tests" ADD CONSTRAINT "package_tests_package_fk" FOREIGN KEY ("lab_id","package_id") REFERENCES "public"."packages"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_tests" ADD CONSTRAINT "package_tests_test_fk" FOREIGN KEY ("lab_id","test_id") REFERENCES "public"."tests"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_attachments" ADD CONSTRAINT "patient_attachments_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_attachments" ADD CONSTRAINT "patient_attachments_patient_fk" FOREIGN KEY ("lab_id","patient_id") REFERENCES "public"."patients"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_groups" ADD CONSTRAINT "payer_groups_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("lab_id","invoice_id") REFERENCES "public"."invoices"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_fk" FOREIGN KEY ("lab_id","method_id") REFERENCES "public"."payment_methods"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_session_fk" FOREIGN KEY ("lab_id","cash_session_id") REFERENCES "public"."cash_sessions"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_payer_fk" FOREIGN KEY ("lab_id","payer_group_id") REFERENCES "public"."payer_groups"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_test_fk" FOREIGN KEY ("lab_id","test_id") REFERENCES "public"."tests"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_materials" ADD CONSTRAINT "qc_materials_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_materials" ADD CONSTRAINT "qc_materials_analyte_fk" FOREIGN KEY ("lab_id","analyte_id") REFERENCES "public"."analytes"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_runs" ADD CONSTRAINT "qc_runs_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_runs" ADD CONSTRAINT "qc_runs_material_fk" FOREIGN KEY ("lab_id","material_id") REFERENCES "public"."qc_materials"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_ranges" ADD CONSTRAINT "reference_ranges_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_ranges" ADD CONSTRAINT "reference_ranges_analyte_fk" FOREIGN KEY ("lab_id","analyte_id") REFERENCES "public"."analytes"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejection_reasons" ADD CONSTRAINT "rejection_reasons_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_tokens" ADD CONSTRAINT "report_tokens_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_tokens" ADD CONSTRAINT "report_tokens_order_fk" FOREIGN KEY ("lab_id","order_id") REFERENCES "public"."orders"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_order_fk" FOREIGN KEY ("lab_id","order_id") REFERENCES "public"."orders"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_attempts" ADD CONSTRAINT "result_attempts_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_attempts" ADD CONSTRAINT "result_attempts_result_fk" FOREIGN KEY ("lab_id","result_id") REFERENCES "public"."results"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_versions" ADD CONSTRAINT "result_versions_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_versions" ADD CONSTRAINT "result_versions_result_fk" FOREIGN KEY ("lab_id","result_id") REFERENCES "public"."results"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_order_fk" FOREIGN KEY ("lab_id","order_id") REFERENCES "public"."orders"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_item_fk" FOREIGN KEY ("lab_id","order_item_id") REFERENCES "public"."order_items"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_analyte_fk" FOREIGN KEY ("lab_id","analyte_id") REFERENCES "public"."analytes"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_events_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_events_sample_fk" FOREIGN KEY ("lab_id","sample_id") REFERENCES "public"."samples"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_types" ADD CONSTRAINT "sample_types_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_order_fk" FOREIGN KEY ("lab_id","order_id") REFERENCES "public"."orders"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_container_fk" FOREIGN KEY ("lab_id","container_id") REFERENCES "public"."containers"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "samples" ADD CONSTRAINT "samples_sample_type_fk" FOREIGN KEY ("lab_id","sample_type_id") REFERENCES "public"."sample_types"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_analytes" ADD CONSTRAINT "test_analytes_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_analytes" ADD CONSTRAINT "test_analytes_test_fk" FOREIGN KEY ("lab_id","test_id") REFERENCES "public"."tests"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_analytes" ADD CONSTRAINT "test_analytes_analyte_fk" FOREIGN KEY ("lab_id","analyte_id") REFERENCES "public"."analytes"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_department_fk" FOREIGN KEY ("lab_id","department_id") REFERENCES "public"."departments"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_sample_type_fk" FOREIGN KEY ("lab_id","sample_type_id") REFERENCES "public"."sample_types"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_container_fk" FOREIGN KEY ("lab_id","container_id") REFERENCES "public"."containers"("lab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_fk" FOREIGN KEY ("lab_id","user_id") REFERENCES "public"."users"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_fk" FOREIGN KEY ("lab_id","role_id") REFERENCES "public"."roles"("lab_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytes_code_uq" ON "analytes" USING btree ("lab_id","code");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("lab_id","status");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("lab_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_seq_idx" ON "audit_log" USING btree ("lab_id","seq");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_code_uq" ON "branches" USING btree ("lab_id","code");--> statement-breakpoint
CREATE INDEX "cash_sessions_open_idx" ON "cash_sessions" USING btree ("lab_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "containers_code_uq" ON "containers" USING btree ("lab_id","code");--> statement-breakpoint
CREATE INDEX "critical_calls_result_idx" ON "critical_calls" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "deliveries_order_idx" ON "deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_code_uq" ON "departments" USING btree ("lab_id","code");--> statement-breakpoint
CREATE INDEX "expenses_paid_idx" ON "expenses" USING btree ("lab_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_mappings_uq" ON "instrument_mappings" USING btree ("instrument_id","instrument_code");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_code_uq" ON "instruments" USING btree ("lab_id","code");--> statement-breakpoint
CREATE INDEX "integration_events_at_idx" ON "integration_events" USING btree ("lab_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_messages_hash_uq" ON "integration_messages" USING btree ("lab_id","instrument_id","raw_hash");--> statement-breakpoint
CREATE INDEX "integration_messages_received_idx" ON "integration_messages" USING btree ("lab_id","instrument_id","received_at");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("lab_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_uq" ON "invoices" USING btree ("lab_id","order_id");--> statement-breakpoint
CREATE INDEX "invoices_created_idx" ON "invoices" USING btree ("lab_id","created_at");--> statement-breakpoint
CREATE INDEX "maintenance_logs_instrument_idx" ON "maintenance_logs" USING btree ("instrument_id","performed_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_sample_idx" ON "order_items" USING btree ("sample_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_accession_uq" ON "orders" USING btree ("lab_id","accession");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("lab_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_patient_idx" ON "orders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("lab_id","status");--> statement-breakpoint
CREATE INDEX "outbox_status_idx" ON "outbox_messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_code_uq" ON "packages" USING btree ("lab_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_mrn_uq" ON "patients" USING btree ("lab_id","mrn");--> statement-breakpoint
CREATE INDEX "patients_created_idx" ON "patients" USING btree ("lab_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_groups_code_uq" ON "payer_groups" USING btree ("lab_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_code_uq" ON "payment_methods" USING btree ("lab_id","code");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_received_idx" ON "payments" USING btree ("lab_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_uq" ON "payments" USING btree ("lab_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "price_overrides_uq" ON "price_overrides" USING btree ("payer_group_id","test_id");--> statement-breakpoint
CREATE INDEX "qc_runs_material_idx" ON "qc_runs" USING btree ("material_id","run_at");--> statement-breakpoint
CREATE INDEX "reference_ranges_analyte_idx" ON "reference_ranges" USING btree ("analyte_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rejection_reasons_code_uq" ON "rejection_reasons" USING btree ("lab_id","code");--> statement-breakpoint
CREATE INDEX "reports_order_idx" ON "reports" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "result_attempts_result_idx" ON "result_attempts" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "result_versions_result_idx" ON "result_versions" USING btree ("result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "results_item_analyte_uq" ON "results" USING btree ("order_item_id","analyte_id");--> statement-breakpoint
CREATE INDEX "results_order_idx" ON "results" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "results_status_idx" ON "results" USING btree ("lab_id","status");--> statement-breakpoint
CREATE INDEX "results_analyte_idx" ON "results" USING btree ("analyte_id");--> statement-breakpoint
CREATE INDEX "review_items_status_idx" ON "review_items" USING btree ("lab_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_key_uq" ON "roles" USING btree ("lab_id","key");--> statement-breakpoint
CREATE INDEX "sample_events_sample_idx" ON "sample_events" USING btree ("sample_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sample_types_code_uq" ON "sample_types" USING btree ("lab_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "samples_barcode_uq" ON "samples" USING btree ("lab_id","barcode");--> statement-breakpoint
CREATE INDEX "samples_order_idx" ON "samples" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "samples_status_idx" ON "samples" USING btree ("lab_id","status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tests_code_uq" ON "tests" USING btree ("lab_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("lab_id","username");