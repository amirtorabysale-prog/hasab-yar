package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.CompanyEntity
import com.example.data.model.UserRole
import com.example.ui.theme.PrimaryEmerald
import com.example.ui.theme.StatusGreen
import com.example.util.PersianUtils

enum class NavigationScreen(val titleFa: String, val icon: ImageVector) {
    DASHBOARD("داشبورد مدیریتی", Icons.Default.Dashboard),
    FAST_ENTRY("ثبت سریع صوتی و هوشمند", Icons.Default.Mic),
    DOCUMENTS("اسناد و فاکتورها", Icons.Default.ReceiptLong),
    TRANSACTIONS("تراکنش‌های مالی", Icons.Default.SyncAlt),
    CONTACTS("اشخاص و طرف‌حساب‌ها", Icons.Default.People),
    CATEGORIES("سرفصل‌ها و دسته‌بندی‌ها", Icons.Default.Category),
    BANKS("بانک و مغایرت‌گیری", Icons.Default.AccountBalance),
    REPORTS("گزارش‌ها و تحلیل مالی", Icons.Default.Assessment),
    EXPORT("خروجی‌ها (سپیدار / هلو / اکسل)", Icons.Default.FileDownload),
    SETTINGS("تنظیمات و پلن کاربری", Icons.Default.Settings)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HesabYarTopAppBar(
    activeCompany: CompanyEntity?,
    companies: List<CompanyEntity>,
    userRole: UserRole,
    onSelectCompany: (Long) -> Unit,
    onCreateNewCompany: () -> Unit,
    onOpenDrawer: () -> Unit,
    onOpenAIChat: () -> Unit,
    modifier: Modifier = Modifier
) {
    var showCompanyMenu by remember { mutableStateOf(false) }

    TopAppBar(
        modifier = modifier.testTag("app_top_bar"),
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = MaterialTheme.colorScheme.onSurface
        ),
        navigationIcon = {
            IconButton(
                onClick = onOpenDrawer,
                modifier = Modifier.testTag("drawer_menu_button")
            ) {
                Icon(Icons.Default.Menu, contentDescription = "منوی اصلی")
            }
        },
        title = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(PrimaryEmerald),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Default.AutoAwesome,
                        contentDescription = "حساب‌یار AI",
                        tint = Color.White,
                        modifier = Modifier.size(20.dp)
                    )
                }

                Column {
                    Text(
                        text = "حساب‌یار هوشمند",
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                    Text(
                        text = "اپراتور حسابداری و مالی هوش مصنوعی",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        },
        actions = {
            // Company Selector Chip
            Box {
                Surface(
                    onClick = { showCompanyMenu = true },
                    shape = RoundedCornerShape(20.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier
                        .padding(end = 4.dp)
                        .testTag("company_selector_chip")
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(StatusGreen)
                        )
                        Text(
                            text = activeCompany?.name ?: "انتخاب شرکت",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1
                        )
                        Icon(
                            imageVector = Icons.Default.ArrowDropDown,
                            contentDescription = "انتخاب شرکت",
                            modifier = Modifier.size(16.dp)
                        )
                    }
                }

                DropdownMenu(
                    expanded = showCompanyMenu,
                    onDismissRequest = { showCompanyMenu = false }
                ) {
                    Text(
                        text = "جابجایی بین شرکت‌ها",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                    )
                    Divider()
                    companies.forEach { comp ->
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(comp.name, fontWeight = FontWeight.SemiBold)
                                    Text(comp.activityType, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            },
                            trailingIcon = {
                                if (comp.id == activeCompany?.id) {
                                    Icon(Icons.Default.Check, contentDescription = null, tint = PrimaryEmerald)
                                }
                            },
                            onClick = {
                                onSelectCompany(comp.id)
                                showCompanyMenu = false
                            }
                        )
                    }
                    Divider()
                    DropdownMenuItem(
                        text = { Text("تعریف شرکت / پرونده مالی جدید +", color = PrimaryEmerald) },
                        leadingIcon = { Icon(Icons.Default.AddBusiness, contentDescription = null, tint = PrimaryEmerald) },
                        onClick = {
                            showCompanyMenu = false
                            onCreateNewCompany()
                        }
                    )
                }
            }

            // AI Assistant Icon
            IconButton(
                onClick = onOpenAIChat,
                modifier = Modifier.testTag("ai_assistant_top_btn")
            ) {
                BadgedBox(
                    badge = {
                        Badge(containerColor = PrimaryEmerald) {
                            Text("AI", fontSize = 9.sp, color = Color.White)
                        }
                    }
                ) {
                    Icon(
                        imageVector = Icons.Default.SmartToy,
                        contentDescription = "دستیار هوشمند حسابداری",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
            }
        }
    )
}

@Composable
fun HesabYarDrawerContent(
    currentScreen: NavigationScreen,
    onSelectScreen: (NavigationScreen) -> Unit,
    activeCompany: CompanyEntity?,
    userRole: UserRole,
    onCloseDrawer: () -> Unit,
    modifier: Modifier = Modifier
) {
    ModalDrawerSheet(
        modifier = modifier.width(300.dp),
        drawerContainerColor = MaterialTheme.colorScheme.surface
    ) {
        // Drawer Header
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(PrimaryEmerald),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.AccountBalanceWallet,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(24.dp)
                        )
                    }
                    Column {
                        Text(
                            text = activeCompany?.name ?: "سامانه حساب‌یار",
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp
                        )
                        Text(
                            text = "نقش: ${userRole.titleFa}",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.8f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("سال مالی جاری: ۱۴۰۵", fontSize = 11.sp)
                        Text("ارز: ${activeCompany?.currency ?: "تومان"}", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }

        Divider()

        // Navigation Items
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(vertical = 8.dp),
            contentPadding = PaddingValues(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            items(NavigationScreen.values()) { screen ->
                val isSelected = currentScreen == screen
                NavigationDrawerItem(
                    label = {
                        Text(
                            text = screen.titleFa,
                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                            fontSize = 13.sp
                        )
                    },
                    icon = {
                        Icon(
                            imageVector = screen.icon,
                            contentDescription = screen.titleFa,
                            tint = if (isSelected) PrimaryEmerald else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    },
                    selected = isSelected,
                    onClick = {
                        onSelectScreen(screen)
                        onCloseDrawer()
                    },
                    colors = NavigationDrawerItemDefaults.colors(
                        selectedContainerColor = PrimaryEmerald.copy(alpha = 0.12f),
                        selectedTextColor = PrimaryEmerald,
                        unselectedTextColor = MaterialTheme.colorScheme.onSurface
                    ),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.testTag("nav_item_${screen.name.lowercase()}")
                )
            }
        }

        Divider()

        // Bottom Footer
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = "HesabYar AI Enterprise v2.4",
                    fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "طراحی‌شده برای اپراتورهای هوشمند حسابداری",
                    fontSize = 9.sp,
                    color = MaterialTheme.colorScheme.outline
                )
            }
        }
    }
}
