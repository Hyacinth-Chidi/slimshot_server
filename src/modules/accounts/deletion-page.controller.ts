import { Controller, Get, Header } from '@nestjs/common';

import { DELETION_PAGE_HTML, DELETION_PAGE_JS } from './deletion-page.content';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/** The web deletion page whose URL goes in the Play Console. */
@Controller('account-deletion')
export class DeletionPageController {
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', CSP)
  page(): string {
    return DELETION_PAGE_HTML;
  }

  @Get('app.js')
  @Header('content-type', 'text/javascript; charset=utf-8')
  script(): string {
    return DELETION_PAGE_JS;
  }
}
