---
title: Privacy Policy — Human in the loop
---

# Privacy Policy

**Human in the loop** · Effective October 3, 2026

## Nothing leaves your machine

Human in the loop is a Claude Code plugin: Claude assigns you the tasks only you can do, they wait in a pane until you act, and your answer goes back to Claude. It runs entirely inside Claude Code on your machine.

- **It collects nothing.** No analytics, telemetry, tracking or crash reporting.
- **It sends nothing.** The plugin makes no network requests. It has no server, and nothing it handles is sent to its author or to anyone else.
- **It shares nothing.** There is no data to sell, rent or hand to third parties.

## What it keeps, and where

- **The tasks Claude assigns you** (their titles, the reasons Claude gave, what counts as done) and, until Claude has received them, **your answers, choices and reasons**.
- They live in the session's own state, and in the plugin's own store: a JSON file under your Claude Code configuration directory, keyed by project folder, so open tasks come back in the next session in that project.
- A task leaves the store once it's done, rejected or withdrawn and Claude has your response.

## What reaches the conversation

Your answers are part of your conversation with Claude, like anything you type: Claude reads them, and Claude Code keeps them in the session's transcript on your machine. That's why tasks ask you to put a secret where it belongs and mark the task done rather than paste it, and why an answer that looks like a secret (an API key, a token, a private key) is held with a warning before it's sent.

The plugin also adds to the conversation the three tools Claude uses to assign, list and withdraw tasks; a few lines in the system prompt telling Claude about tasks; and, at a conversation's start or after a compaction, a short list of the tasks still open.

## Claude Code itself

This policy covers only this plugin. Claude Code, and the model it talks to, handle your data under Anthropic's own terms and privacy policy, whether or not the plugin is installed.

## Changes

If this policy changes, the new version will be posted on this page with a new effective date. The history of every change is public in the [repository](https://github.com/tzafrir/human-in-the-loop/commits/main/docs/privacy.md).
