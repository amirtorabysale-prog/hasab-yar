package com.example.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.DocumentSource
import com.example.data.model.DocumentStatus
import com.example.data.model.DocumentType
import com.example.data.model.IssueSeverity
import com.example.ui.theme.*
import com.example.util.PersianUtils

@Composable
fun DocumentStatusBadge(status: DocumentStatus, modifier: Modifier = Modifier) {
    val (bgColor, textColor, icon) = when (status) {
        DocumentStatus.APPROVED -> Triple(StatusGreen.copy(alpha = 0.12f), StatusGreen, Icons.Default.CheckCircle)
        DocumentStatus.NEEDS_REVIEW -> Triple(StatusYellow.copy(alpha = 0.15f), StatusYellowDark, Icons.Default.ErrorOutline)
        DocumentStatus.DRAFT -> Triple(Color.Gray.copy(alpha = 0.12f), Color.DarkGray, Icons.Default.EditNote)
        DocumentStatus.EXPORTED -> Triple(PrimaryEmerald.copy(alpha = 0.15f), PrimaryEmerald, Icons.Default.CloudDone)
        DocumentStatus.REJECTED -> Triple(StatusRed.copy(alpha = 0.12f), StatusRed, Icons.Default.Cancel)
    }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = bgColor,
        modifier = modifier
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Icon(imageVector = icon, contentDescription = null, tint = textColor, modifier = Modifier.size(12.dp))
            Text(text = status.titleFa, color = textColor, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
fun DocumentTypeBadge(type: DocumentType, modifier: Modifier = Modifier) {
    val (bgColor, textColor) = when (type) {
        DocumentType.PURCHASE -> Pair(Color(0xFFEDE7F6), Color(0xFF512DA8))
        DocumentType.SALE -> Pair(Color(0xFFE8F5E9), Color(0xFF2E7D32))
        DocumentType.EXPENSE -> Pair(Color(0xFFFFEBEE), Color(0xFFC62828))
        DocumentType.INCOME -> Pair(Color(0xFFE0F2F1), Color(0xFF00695C))
        DocumentType.RECEIPT -> Pair(Color(0xFFE3F2FD), Color(0xFF1565C0))
        DocumentType.PAYMENT -> Pair(Color(0xFFFFF3E0), Color(0xFFE65100))
    }

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = bgColor,
        modifier = modifier
    ) {
        Text(
            text = type.titleFa,
            color = textColor,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
        )
    }
}

@Composable
fun ConfidenceBadge(confidence: Float, modifier: Modifier = Modifier) {
    val percent = (confidence * 100).toInt()
    val (color, text) = when {
        percent >= 90 -> Pair(StatusGreen, "دقت بالا ($percent٪)")
        percent >= 70 -> Pair(StatusYellowDark, "دقت متوسط ($percent٪)")
        else -> Pair(StatusRed, "نیازمند بازبینی ($percent٪)")
    }

    Surface(
        shape = RoundedCornerShape(6.dp),
        color = color.copy(alpha = 0.12f),
        modifier = modifier
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(color)
            )
            Text(text = text, color = color, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
fun MetricCard(
    title: String,
    value: String,
    subtitle: String? = null,
    icon: ImageVector,
    accentColor: Color = PrimaryEmerald,
    modifier: Modifier = Modifier
) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        modifier = modifier
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(text = title, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(text = value, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
                if (subtitle != null) {
                    Text(text = subtitle, fontSize = 10.sp, color = accentColor, fontWeight = FontWeight.SemiBold)
                }
            }
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(accentColor.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(imageVector = icon, contentDescription = null, tint = accentColor, modifier = Modifier.size(22.dp))
            }
        }
    }
}

@Composable
fun AudioWaveformVisualizer(
    isListening: Boolean,
    amplitude: Float,
    modifier: Modifier = Modifier
) {
    val infiniteTransition = rememberInfiniteTransition(label = "waveform")
    val animOffset by infiniteTransition.animateFloat(
        initialValue = 0.2f,
        targetValue = 1.0f,
        animationSpec = infiniteRepeatable(
            animation = tween(400, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "offset"
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceEvenly
    ) {
        val barCount = 24
        for (i in 0 until barCount) {
            val dynamicHeight = if (isListening) {
                val wave = Math.sin((i.toDouble() / barCount) * Math.PI * 3 + animOffset * 4).toFloat()
                val heightNorm = (Math.abs(wave) * 0.6f + amplitude * 0.4f).coerceIn(0.15f, 1.0f)
                (heightNorm * 38).dp
            } else {
                6.dp
            }

            Box(
                modifier = Modifier
                    .width(4.dp)
                    .height(dynamicHeight)
                    .clip(RoundedCornerShape(2.dp))
                    .background(if (isListening) PrimaryEmerald else MaterialTheme.colorScheme.outlineVariant)
            )
        }
    }
}

@Composable
fun SectionHeader(title: String, actionText: String? = null, onActionClick: (() -> Unit)? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = title,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface
        )
        if (actionText != null && onActionClick != null) {
            TextButton(onClick = onActionClick) {
                Text(text = actionText, fontSize = 12.sp, color = PrimaryEmerald)
            }
        }
    }
}

@Composable
fun EmptyStateView(
    icon: ImageVector,
    title: String,
    description: String,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(28.dp)
                )
            }
            Text(text = title, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(
                text = description,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center
            )
        }
    }
}
