import { ROLE_TEMPLATES } from '@oxrana/contracts';
import { roleTemplatesSyncSql } from './role-sync-sql';

process.stdout.write(roleTemplatesSyncSql(ROLE_TEMPLATES));
