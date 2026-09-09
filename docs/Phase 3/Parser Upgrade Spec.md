# CODESYS Parser Platform - Development Specification



## Goal



Create a single parser core that enables:  



1. VS Code Extension for human editing  

2. Claude/Copilot interception layer for AI interaction  

3. Git clean/smudge integration for source control  
   
   

Users should work with `.pro` files naturally without manual export/import workflows.  



---  



# Architecture



```text

┌───────────────┐  

│ Parser Core │  

└───────┬───────┘  

│  

┌──────────────────┼──────────────────┐  

│ │ │  

▼ ▼ ▼  



VS Code Claude Hook Git Filter  



.pro files .pro appears .pro stored as  

editable as ST project ST in Git  

```



---  



# Core Component



## codesys-parser



**Language:** TypeScript  



### Responsibilities



```text

Parse(.pro)  

Rebuild(project)  

Export(project)  

Import(project)  

Diff(projectA, projectB)  

Validate(project)  

```



### Canonical Project Model



```text

Project  

├── POUs  

├── Functions  

├── Function Blocks  

├── GVLs  

├── DUTs  

├── Tasks  

├── Libraries  

└── Metadata  

```



### Requirements



```text

Deterministic  

Lossless  

Versioned  

Testable  

```



---  



# VS Code Extension



## Purpose



Human engineering interface.  



## Features



```text

Custom .pro editor  

Virtual file system  

ST tabs  

Save back to .pro  

Search  

Navigation  

```



## Architecture



```text

.pro  

↓  

Parser  

↓  

Virtual Files  

↓  

VS Code  

```



### Responsibilities



- Open `.pro`  

- Present project as virtual ST source tree  

- Permit editing  

- Rebuild `.pro` on save  
  
  

### Non-Responsibilities



- Git integration  

- Claude integration  

- Source control management  
  
  

---  



# Claude / Copilot Integration



## Goal



Allow AI agents to interact with `.pro` projects as if they were ordinary source trees.  



## Design



Implement filesystem hooks/interceptors for:  



```text

ReadFile  

ReadDirectory  

Glob  

Search  

```



Claude should never need to learn CODESYS.  



Claude should never need custom commands.  



Claude should never need to invoke parser tools manually.  



---  



## ReadDirectory Behaviour



Input:  



```text

Airport.pro  

```



Return:  



```text

Airport.pro/  

├── POUS/  

├── GVL/  

├── DUT/  

├── Tasks/  

└── Libraries/  

```



Generated dynamically from parser output.  



---  



## ReadFile Behaviour



Input:  



```text

Airport.pro/POUS/Main.st  

```



Return:  



```st

PROGRAM Main  

...  

```



Generated dynamically from parsed model.  



---  



## WriteFile Behaviour



Input:  



```text

Airport.pro/POUS/Main.st  

```



Process:  



```text

Update parsed model  

Rebuild .pro  

Write .pro  

```



Result:  



```text

Airport.pro updated  

```



No temporary files.  



No exported folders.  



No user-visible artifacts.  



---  



# Git Integration



## Design Goal



Working tree should contain:  



```text

Airport.pro  

```



only.  



Source representation should live exclusively inside Git.  



No generated folders.  



No `.codesys`.  



No `.generated`.  



No artifacts left behind.  



---  



# Clean Filter



## Trigger Events



```text

git add  

git commit  

```



## Process



```text

Airport.pro  

↓  

Parser  

↓  

Canonical Source Representation  

↓  

Git Object Database  

```



## Stored Representation



```text

project.json  



POUS/  

Main.st  

Conveyor.st  



GVL/  

Globals.gvl  



DUT/  

Alarms.dut  



Tasks/  

MainTask.json  

```



Git stores source code only.  



Git never stores binary payloads.  



---  



# Smudge Filter



## Trigger Events



```text

git clone  

git checkout  

git switch  

git pull  

git restore  

git stash pop  

git merge  

git rebase  

```



## Process



```text

Canonical Source Representation  

↓  

Parser  

↓  

Airport.pro  

```



Result visible to user:  



```text

Airport.pro  

```



only.  



---  



# Repository State



## Working Tree



```text

Airport.pro  

```



## Hidden State



None.  



No temp directories.  



No export trees.  



No generated project mirrors.  



All conversions occur in memory.  



---  



# GitHub / GitLab Benefits



```text

Line diffs  

Pull request reviews  

Code search  

Blame  

History  

Semantic merges  

```



Example:  



```diff

- MotorStart := FALSE;  

+ MotorStart := TRUE;  

```



instead of:  



```text

Binary files differ  

```



---  



# Canonical Storage Format



## Requirements



```text

Stable ordering  

No timestamps  

No machine paths  

No random IDs  

UTF-8  

LF line endings  

```



Identical project content must always generate identical Git content.  



---  



# Validation Pipeline



Every conversion operation must execute:  



```text

Parse  

↓  

Export  

↓  

Rebuild  

↓  

Verify  

```



## Failure Conditions



Abort operation when:  



```text

Parser exception  

Rebuild mismatch  

Lossy conversion  

Schema violation  

```



Never allow invalid source representations into Git.  



---  



# Phase 2 - Merge Driver



After clean/smudge is stable:  



```text

merge=codesys  

```



Custom merge implementation:  



```text

POU-aware merges  

GVL-aware merges  

Rename tracking  

Structural conflict detection  

Deterministic rebuild  

```



---  



# Final Architecture



```text

codesys-parser  

│  

├── Parse  

├── Rebuild  

├── Export  

├── Import  

├── Diff  

└── Validate  

```



## Consumers



```text

VS Code Extension  

↓  



Claude/Copilot Hooks  

↓  



Git Clean/Smudge Filters  

```



## Outcomes



```text

Single parser core  

Single source of truth  

Native VS Code editing  

Native Claude interaction  

Native Git history  

No generated folders  

No manual export/import workflow  

No AI-specific commands  

Clean repositories  

```
