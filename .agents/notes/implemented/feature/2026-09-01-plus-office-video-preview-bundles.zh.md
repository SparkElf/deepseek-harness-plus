# Agent Note: Plus Office与视频预览bundle

Status: implemented

[English](2026-09-01-plus-office-video-preview-bundles.md) | 中文

## 问题

Better Sidebar把重量级Office rendering与video streaming保留在独立extension bundles中。若继续把它们作为安装后的手工命令，Plus发行版、本机服务及managed workspace会暴露不同的preview capabilities。

## 决策

Plus profile在`dsh-better-sidebar@0.17.1`之后紧接安装`@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.2`与`dsh-video-preview@0.1.4`。发行版把三个包都作为exact profile dependencies安装，并在deployment lock中把两个preview packages记录为runtime bundles。

本机Plus与DataOps workspace image消费同一份materialized profile。两个deployment都不执行独立plugin installation。

## 已考虑的替代方案

**部署后分别安装plugin。** 否决，因为三份mutable installation会偏离released profile，并彼此漂移。

**把preview implementation复制到Plus或Better Sidebar patch。** 否决，因为两个package都已提供完整DSH bundle contract，并由各自上游独立维护。

## 后果

每个Plus deployment都能通过Better Sidebar预览DOCX、XLSX、PPTX及supported video files。Office bundle增加22.4 MB unpacked client artifact及其rendering dependencies，因此profile installation与client loading成本会上升。版本升级继续作为显式distribution change，不跟随ambient npm update。
